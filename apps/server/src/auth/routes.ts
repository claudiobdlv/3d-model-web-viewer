import express from "express";
import type { AuthConfig } from "./config.js";
import { redirectUri } from "./config.js";
import type { AuthService } from "./service.js";
import { signPayload, verifyPayload } from "./tokens.js";
import {
  buildAuthorizationRequest,
  discover,
  exchangeCodeForTokens,
  validateDiscoveryIssuer,
  verifyAndProfile
} from "./oidc.js";
import { parseCookies } from "./middleware.js";
import { RateLimiter, clientIp, loadAuthRateLimitConfig } from "./rateLimit.js";
import type { Provider } from "./types.js";

const OAUTH_TXN_COOKIE = "modelbase_oauth_txn";
const TXN_TTL_MS = 10 * 60 * 1000;

interface OauthTxn {
  provider: Provider;
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
  exp: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeNext(value: unknown): string {
  // Only allow same-origin relative paths to prevent open-redirects.
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/admin";
  return value;
}

function isProvider(value: string): value is Provider {
  return value === "google" || value === "microsoft";
}

function setSessionCookie(res: express.Response, config: AuthConfig, token: string): void {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: config.sameSite,
    path: "/",
    maxAge: config.sessionTtlMs
  });
}

function clearSessionCookie(res: express.Response, config: AuthConfig): void {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: config.sameSite,
    path: "/"
  });
}

function renderLoginPage(config: AuthConfig, next: string, message?: string): string {
  // Provider buttons reflect both the AUTH_PROVIDERS allow-list and whether
  // credentials are configured (config.providers already accounts for both —
  // see loadAuthConfig). Google-only is the default/intended provider list for
  // this phase; Microsoft only appears once explicitly re-enabled.
  const providers: Array<{ id: Provider; label: string }> = [];
  if (config.providers.google) providers.push({ id: "google", label: "Continue with Google" });
  if (config.providers.microsoft) providers.push({ id: "microsoft", label: "Continue with Microsoft" });

  const nextParam = `?next=${encodeURIComponent(next)}`;
  const buttons = providers.length
    ? providers
        .map(
          (provider) =>
            `<a class="btn" href="/auth/${provider.id}/start${nextParam}">${escapeHtml(provider.label)}</a>`
        )
        .join("\n")
    : `<p class="muted">No sign-in providers are configured yet. Set the Google client credentials and enable accounts to continue.</p>`;

  const providerNames = providers.map((provider) => (provider.id === "google" ? "Google" : "Microsoft"));
  const subtitle =
    providerNames.length === 1 && providerNames[0] === "Google"
      ? "Admin access uses Google sign-in."
      : "Sign in to manage your 3D models.";
  const privacyProviderText = providerNames.length ? providerNames.join(" or ") : "Google";

  const banner = message ? `<div class="banner">${escapeHtml(message)}</div>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Sign in · ModelBase</title>
<style>
  :root { color-scheme: dark; }
  body { font: 16px/1.5 system-ui, sans-serif; background: #0b0d10; color: #f8fafc; margin: 0; display: grid; min-height: 100vh; place-items: center; }
  main { width: min(92vw, 380px); padding: 2rem; background: #12161c; border: 1px solid #1f2630; border-radius: 16px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .muted { color: #94a3b8; font-size: .9rem; }
  .btn { display: block; text-align: center; padding: .8rem 1rem; margin: .6rem 0; background: #1d4ed8; color: #fff; border-radius: 10px; text-decoration: none; font-weight: 600; }
  .btn:hover { background: #2563eb; }
  .banner { background: #7f1d1d; color: #fee2e2; padding: .7rem .9rem; border-radius: 10px; margin-bottom: 1rem; font-size: .9rem; }
  .privacy { margin-top: 1.25rem; font-size: .8rem; color: #94a3b8; }
</style>
</head>
<body>
<main>
  <h1>ModelBase</h1>
  <p class="muted">${escapeHtml(subtitle)}</p>
  ${banner}
  ${buttons}
  <p class="privacy">Models are private by default. We only use your ${escapeHtml(privacyProviderText)} profile to identify your account. Public share links are explicit and revocable.</p>
</main>
</body>
</html>`;
}

function renderErrorPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · ModelBase</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0d10;color:#f8fafc;display:grid;min-height:100vh;place-items:center;margin:0}main{width:min(92vw,420px);padding:2rem;text-align:center}a{color:#60a5fa}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${body}</p><p><a href="/login">Back to sign in</a></p></main></body></html>`;
}

// Builds the accounts router. Mounted only when accounts are enabled.
export function createAuthRouter(service: AuthService, config: AuthConfig): express.Router {
  const router = express.Router();

  // Per-process, in-memory rate limiting for the auth endpoints only. These
  // limiters are never attached to public QR/model routes (which live outside
  // this router) or to converter upload routes. See auth/rateLimit.ts.
  const rl = loadAuthRateLimitConfig();
  const oauthLimiter = new RateLimiter({ windowMs: rl.windowMs, max: rl.oauthMax });
  const loginLimiter = new RateLimiter({ windowMs: rl.windowMs, max: rl.loginMax });

  // Wraps a limiter as middleware keyed by client IP. On limit it returns 429
  // with a Retry-After header (and a tiny no-store HTML body), short-circuiting
  // before any OAuth/discovery work is done.
  const limit =
    (limiter: RateLimiter): express.RequestHandler =>
    (req, res, next) => {
      const decision = limiter.hit(clientIp(req));
      if (decision.allowed) {
        next();
        return;
      }
      const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      res
        .status(429)
        .setHeader("Retry-After", String(retryAfterSec));
      res.setHeader("Cache-Control", "no-store");
      res
        .type("html")
        .send(renderErrorPage("Too many attempts", "Too many sign-in attempts. Please wait a moment and try again."));
    };

  router.get("/login", limit(loginLimiter), (req, res) => {
    if (req.auth) {
      res.redirect(302, safeNext(req.query.next));
      return;
    }
    let message: string | undefined;
    if (req.query.error === "collision") {
      message = "An account already exists for this email with a different sign-in method. Please sign in with your original provider.";
    } else if (req.query.error === "no_email") {
      message = "Your provider did not share a verified email address, which is required to sign in.";
    } else if (req.query.error === "email_not_allowed") {
      message = "This Google account is not approved for admin access. Contact an administrator if you believe this is a mistake.";
    } else if (req.query.error) {
      message = "Sign-in could not be completed. Please try again.";
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderLoginPage(config, safeNext(req.query.next), message));
  });

  router.get("/auth/:provider/start", limit(oauthLimiter), async (req, res) => {
    const provider = String(req.params.provider);
    if (!isProvider(provider)) {
      res.status(404).type("html").send(renderErrorPage("Unknown provider", "That sign-in provider is not available."));
      return;
    }
    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      await service.recordProviderUnavailable(provider, "start");
      res.status(503).type("html").send(renderErrorPage("Provider unavailable", "This sign-in provider is not configured."));
      return;
    }
    try {
      const discovery = await discover(providerConfig.issuer);
      if (!validateDiscoveryIssuer(discovery.issuer, providerConfig)) {
        throw new Error("discovery_issuer_mismatch");
      }
      const authRequest = buildAuthorizationRequest({
        discovery,
        clientId: providerConfig.clientId,
        redirectUri: redirectUri(config, provider),
        scopes: providerConfig.scopes
      });
      const txn: OauthTxn = {
        provider,
        state: authRequest.state,
        nonce: authRequest.nonce,
        codeVerifier: authRequest.codeVerifier,
        next: safeNext(req.query.next),
        exp: Date.now() + TXN_TTL_MS
      };
      res.cookie(OAUTH_TXN_COOKIE, signPayload(txn, config.sessionSecret), {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: config.sameSite,
        path: "/",
        maxAge: TXN_TTL_MS
      });
      res.redirect(302, authRequest.url);
    } catch (error) {
      console.error("auth.start_failed", { provider, message: error instanceof Error ? error.message : "unknown" });
      res.status(502).type("html").send(renderErrorPage("Sign-in unavailable", "Could not start sign-in. Please try again later."));
    }
  });

  router.get("/auth/:provider/callback", limit(oauthLimiter), async (req, res) => {
    const provider = String(req.params.provider);
    if (!isProvider(provider)) {
      res.status(404).type("html").send(renderErrorPage("Unknown provider", "That sign-in provider is not available."));
      return;
    }
    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      await service.recordProviderUnavailable(provider, "callback");
      res.status(503).type("html").send(renderErrorPage("Provider unavailable", "This sign-in provider is not configured."));
      return;
    }

    const txnRaw = parseCookies(req.headers.cookie)[OAUTH_TXN_COOKIE];
    const txn = txnRaw ? verifyPayload<OauthTxn>(txnRaw, config.sessionSecret) : undefined;
    res.clearCookie(OAUTH_TXN_COOKIE, { path: "/" });

    if (!txn || txn.provider !== provider || txn.exp < Date.now()) {
      res.status(400).type("html").send(renderErrorPage("Sign-in expired", "Your sign-in session expired. Please try again."));
      return;
    }
    if (typeof req.query.error === "string") {
      res.redirect(302, "/login?error=provider");
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || state !== txn.state) {
      res.status(400).type("html").send(renderErrorPage("Invalid sign-in", "The sign-in response was invalid. Please try again."));
      return;
    }

    try {
      const discovery = await discover(providerConfig.issuer);
      if (!validateDiscoveryIssuer(discovery.issuer, providerConfig)) {
        throw new Error("discovery_issuer_mismatch");
      }
      const tokens = await exchangeCodeForTokens({
        discovery,
        clientId: providerConfig.clientId,
        clientSecret: providerConfig.clientSecret,
        code,
        redirectUri: redirectUri(config, provider),
        codeVerifier: txn.codeVerifier
      });
      if (!tokens.id_token) {
        throw new Error("missing_id_token");
      }
      const profile = await verifyAndProfile({
        idToken: tokens.id_token,
        discovery,
        config: providerConfig,
        nonce: txn.nonce
      });

      const result = await service.loginWithProvider(profile);
      if (!result.ok) {
        const errorCode = result.reason === "account_exists_different_provider" ? "collision" : result.reason;
        res.redirect(302, `/login?error=${encodeURIComponent(errorCode)}`);
        return;
      }

      const { token } = await service.createSession(result.user.id, {
        activeOrganizationId: result.organization.id,
        ipAddress: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || null,
        userAgent: req.header("user-agent") || null
      });
      setSessionCookie(res, config, token);
      res.redirect(302, safeNext(txn.next));
    } catch (error) {
      console.error("auth.callback_failed", { provider, message: error instanceof Error ? error.message : "unknown" });
      res.redirect(302, "/login?error=callback");
    }
  });

  // Strict POST-only logout. Revoking a session is a state change, so it must
  // not be reachable via a cross-site GET (e.g. an <img>/<a> pointed at
  // /auth/logout): that would let a third-party page force-terminate the
  // victim's session (logout CSRF). The admin UI signs out with
  // `POST /auth/logout` (apps/web/src/api.ts `postLogout`).
  router.post("/auth/logout", async (req, res) => {
    const token = parseCookies(req.headers.cookie)[config.cookieName];
    await service.logout(token);
    clearSessionCookie(res, config);
    res.redirect(302, "/login");
  });
  // GET is intentionally NOT a logout. It neither revokes the session nor
  // clears the cookie; it returns a 405 telling the caller to use the sign-out
  // button. Kept (rather than 404) so an old bookmarked link lands somewhere
  // sensible instead of erroring, while closing the GET-logout CSRF vector.
  router.get("/auth/logout", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.setHeader("Cache-Control", "no-store");
    res
      .status(405)
      .type("html")
      .send(
        renderErrorPage(
          "Use the sign-out button",
          "Signing out happens through the account menu. Your session was not changed by visiting this link."
        )
      );
  });

  // Current session info for the admin account menu.
  router.get("/api/me", (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!req.auth) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      user: {
        id: req.auth.user.id,
        email: req.auth.user.primary_email,
        displayName: req.auth.user.display_name,
        avatarUrl: req.auth.user.avatar_url
      },
      organization: req.auth.organization
        ? { id: req.auth.organization.id, name: req.auth.organization.name, slug: req.auth.organization.slug }
        : null,
      role: req.auth.membership?.role ?? null
    });
  });

  return router;
}
