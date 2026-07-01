// Static informational pages (/privacy, /security). Deliberately independent
// of the accounts feature flag: they carry no auth-specific data, so they stay
// reachable whether or not AUTH_ENABLED is set, and are safe to link from the
// (feature-flagged) /login page once accounts are turned on.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageShell(title: string, tagline: string, items: string[], footerLinkLabel: string, footerLinkHref: string): string {
  const list = items.map((item) => `<li>${item}</li>`).join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)} · ModelBase</title>
<style>
  :root { color-scheme: dark; }
  body { font: 16px/1.5 system-ui, sans-serif; background: #0b0d10; color: #f8fafc; margin: 0; display: grid; min-height: 100vh; place-items: center; padding: 2rem 1rem; }
  main { width: min(92vw, 560px); padding: 2.25rem 2rem; background: #12161c; border: 1px solid #1f2630; border-radius: 16px; }
  .brand-mark { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #2563eb, #1d4ed8); display: grid; place-items: center; font-weight: 800; font-size: 1.05rem; margin-bottom: 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
  .tagline { margin: 0 0 1.4rem; color: #cbd5e1; font-size: .95rem; }
  ul.policy-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .9rem; }
  ul.policy-list li { font-size: .9rem; line-height: 1.6; color: #cbd5e1; padding-left: 1.1rem; position: relative; }
  ul.policy-list li::before { content: "•"; position: absolute; left: 0; color: #7fa8f5; }
  ul.policy-list strong { color: #f8fafc; }
  .footer-links { margin-top: 1.6rem; padding-top: 1.1rem; border-top: 1px solid #1f2630; font-size: .82rem; }
  .footer-links a { color: #7fa8f5; text-decoration: none; }
  .footer-links a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <div class="brand-mark">M</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="tagline">${escapeHtml(tagline)}</p>
  <ul class="policy-list">
      ${list}
  </ul>
  <p class="footer-links"><a href="${footerLinkHref}">${escapeHtml(footerLinkLabel)}</a></p>
</main>
</body>
</html>`;
}

export function renderPrivacyPage(): string {
  return pageShell(
    "Privacy",
    "How ModelBase handles your models and data.",
    [
      "<strong>Private by default.</strong> Uploaded models and workspaces are private. Nothing is publicly visible unless a share link is explicitly created for it.",
      "<strong>Explicit, revocable share links.</strong> Public links are opt-in, created per model, and can be revoked at any time — revoking one takes effect immediately.",
      "<strong>Source downloads are controllable.</strong> Original source files (e.g. STEP) can be restricted separately from the shared display model, so a public link does not have to expose your source file.",
      "<strong>Not used to train AI models.</strong> Uploaded files and models are not used to train AI or machine-learning models.",
      "<strong>Secrets stay out of the UI.</strong> Session tokens, OAuth credentials, and other secrets are never shown in the admin interface or in any audit log entry.",
      "<strong>Deletion and backups.</strong> Deleting a model removes it from your active workspace. Backup/retention timelines for deleted data are not yet finalized and will be documented here before public launch — deletion should not be assumed to be instant or permanent across every backup today."
    ],
    "Security",
    "/security"
  );
}

export function renderSecurityPage(): string {
  return pageShell(
    "Security",
    "How ModelBase protects workspace access.",
    [
      "<strong>Google sign-in.</strong> Admin access uses Google OAuth. ModelBase never sees or stores your Google password.",
      "<strong>Workspace-scoped access.</strong> Every model, share link, and setting belongs to a workspace; members only see the workspaces they belong to.",
      "<strong>Approved accounts only.</strong> Signing in requires an approved Google account. An unapproved sign-in attempt is rejected and no account is created.",
      "<strong>Session security.</strong> Sessions are stored server-side as hashed tokens behind an httpOnly, secure cookie — never in browser storage, and never readable by page scripts.",
      "<strong>Audit trail.</strong> Sign-ins, sign-outs, and access denials are recorded in a workspace-scoped security log visible to workspace admins.",
      "<strong>No secret exposure.</strong> Tokens, cookies, and OAuth payloads are never shown in any admin screen, audit entry, or API response."
    ],
    "Privacy",
    "/privacy"
  );
}
