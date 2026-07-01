import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, Monitor, ShieldCheck, X } from "lucide-react";
import { getAuditEvents, getSessions, postLogout, revokeSession } from "../api";
import type { AuditEventSummary, MeResponse, SessionSummary } from "../api";

const PROVIDER_LABEL: Record<string, string> = { google: "Google", microsoft: "Microsoft" };

const AUDIT_EVENT_LABEL: Record<string, string> = {
  "login.success": "Signed in",
  "login.collision": "Sign-in blocked (account exists with a different provider)",
  "login.rejected": "Sign-in denied",
  "logout": "Signed out",
  "session.created": "New session started",
  "session.revoked": "Session revoked",
  "user.created": "Account created",
  "organization.created": "Workspace created",
  "auth.provider_unavailable": "Sign-in provider unavailable"
};

function formatEventType(type: string): string {
  return AUDIT_EVENT_LABEL[type] ?? type;
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

// Authenticated account settings panel: profile/workspace summary, the
// caller's own signed-in sessions (with revoke), and — for admin/owner roles
// only — a recent security/audit log. Sessions and audit data are fetched
// independently; a failure or a 403 on the audit call (member/viewer role)
// simply hides that section rather than showing an error, since it is not a
// failure from the signed-in user's point of view.
export function AccountSettingsModal({
  me,
  onClose
}: {
  me: Extract<MeResponse, { authenticated: true }>;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEventSummary[] | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [signOutBusy, setSignOutBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSessions()
      .then((list) => { if (!cancelled) setSessions(list); })
      .catch(() => { if (!cancelled) setSessionsError("Sessions could not be loaded."); });
    getAuditEvents()
      .then((events) => { if (!cancelled) setAuditEvents(events); })
      .catch(() => { /* not an admin/owner, or not available yet — section stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  const label = me.user.displayName || me.user.email;
  const providerLabel = me.provider ? PROVIDER_LABEL[me.provider] ?? me.provider : "—";

  const handleRevoke = async (sessionId: string) => {
    setBusySessionId(sessionId);
    setSessionsError(null);
    try {
      await revokeSession(sessionId);
      setSessions((current) => current?.filter((session) => session.id !== sessionId) ?? current);
    } catch {
      setSessionsError("Could not revoke that session. Please try again.");
    } finally {
      setBusySessionId(null);
    }
  };

  const handleSignOut = async () => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    await postLogout();
  };

  return createPortal(
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Account settings"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="dialog-card account-settings-card">
        <header>
          <h2>Account settings</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>
        <div className="account-settings-body">
          <section className="account-settings-section">
            <div className="account-settings-profile">
              <strong>{label}</strong>
              {me.user.displayName && <span className="account-settings-muted">{me.user.email}</span>}
              <span className="account-settings-chip-row">
                <span className="account-settings-chip">{providerLabel}</span>
                {me.role && <span className="account-settings-chip">{me.role}</span>}
              </span>
              {me.organization && <span className="account-settings-muted">{me.organization.name}</span>}
            </div>
            <button className="danger-button" onClick={() => void handleSignOut()} disabled={signOutBusy}>
              <LogOut size={15} />{signOutBusy ? "Signing out…" : "Sign out"}
            </button>
          </section>

          <section className="account-settings-section">
            <h3><Monitor size={14} /> Sessions</h3>
            {sessionsError && <p className="account-settings-error">{sessionsError}</p>}
            {!sessions && !sessionsError && <p className="account-settings-muted">Loading sessions…</p>}
            {sessions && sessions.length === 0 && <p className="account-settings-muted">No active sessions.</p>}
            {sessions && sessions.length > 0 && (
              <ul className="account-settings-list">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <div>
                      <strong>{session.current ? "This device" : "Other device"}</strong>
                      <span className="account-settings-muted">
                        {session.lastUsedAt
                          ? `Last active ${formatTimestamp(session.lastUsedAt)}`
                          : `Created ${formatTimestamp(session.createdAt)}`}
                      </span>
                    </div>
                    {!session.current && (
                      <button
                        className="account-settings-revoke"
                        disabled={busySessionId === session.id}
                        onClick={() => void handleRevoke(session.id)}
                      >
                        {busySessionId === session.id ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {auditEvents && (
            <section className="account-settings-section">
              <h3><ShieldCheck size={14} /> Recent security events</h3>
              {auditEvents.length === 0 ? (
                <p className="account-settings-muted">No recent security events.</p>
              ) : (
                <ul className="account-settings-list account-settings-audit">
                  {auditEvents.slice(0, 20).map((event) => (
                    <li key={event.id}>
                      <span>{formatEventType(event.type)}</span>
                      <span className="account-settings-muted">{formatTimestamp(event.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
