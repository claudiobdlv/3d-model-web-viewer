import type express from "express";

// Lightweight, dependency-free, per-process in-memory rate limiting for the
// auth endpoints only. This is intentionally NOT applied to public QR/model
// viewer routes or to converter upload routes — it lives on the accounts
// router, which is mounted only when AUTH_ENABLED=true. State is per-process
// (a single Node server); a future multi-instance deployment would move this
// to a shared store.

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

// Fixed-window counter keyed by an arbitrary string (typically client IP).
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  // Records a hit for `key` and reports whether it is allowed. A denied hit
  // does NOT extend the window or increment the counter, so a caller cannot be
  // kept permanently locked out by hammering the endpoint.
  hit(key: string, now: number = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return { allowed: true, remaining: this.options.max - 1, retryAfterMs: 0 };
    }
    if (bucket.count >= this.options.max) {
      return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count += 1;
    return { allowed: true, remaining: this.options.max - bucket.count, retryAfterMs: 0 };
  }

  // Clears all state. Used by tests; also handy for an explicit reset.
  reset(): void {
    this.buckets.clear();
  }

  // Opportunistic cleanup of expired buckets to bound memory under churn.
  prune(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

// Best-effort client IP: first hop of X-Forwarded-For (set by the reverse
// proxy in production), falling back to the socket address. Only used as a
// rate-limit bucket key, never trusted for authorization.
export function clientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = header?.split(",")[0]?.trim();
  return first || req.ip || req.socket?.remoteAddress || "unknown";
}

export interface AuthRateLimitConfig {
  windowMs: number;
  // Authorization start + callback (the OAuth round-trip endpoints).
  oauthMax: number;
  // The /login page render.
  loginMax: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Reads optional env overrides so tests (and tuning) can scale limits without a
// code change. Defaults are deliberately generous — enough headroom for normal
// interactive use, low enough to blunt automated abuse.
export function loadAuthRateLimitConfig(env: NodeJS.ProcessEnv = process.env): AuthRateLimitConfig {
  const windowMs = intFromEnv(env.AUTH_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000);
  const oauthMax = intFromEnv(env.AUTH_RATE_LIMIT_MAX, 20);
  const loginMax = intFromEnv(env.AUTH_RATE_LIMIT_LOGIN_MAX, Math.max(oauthMax * 3, 60));
  return { windowMs, oauthMax, loginMax };
}
