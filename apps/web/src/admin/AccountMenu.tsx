import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, Settings } from "lucide-react";
import { postLogout } from "../api";
import type { MeResponse } from "../api";
import { AccountSettingsModal } from "./AccountSettingsModal";

// Renders the account menu only when there is an authenticated session. The
// session is identified purely by the server-side httpOnly cookie via
// `getMe()` — no token is ever read from or written to localStorage/
// sessionStorage on the client.
export function AccountMenuSlot({ me }: { me: MeResponse | null }) {
  if (!me || !me.authenticated) return null;
  return <AccountMenu me={me} />;
}

export function AccountMenu({ me }: { me: Extract<MeResponse, { authenticated: true }> }) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [busy, setBusy] = useState(false);
  const menuWidth = 220;

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const height = menuRef.current?.offsetHeight ?? 110;
      const gap = 5;
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth)),
        top: rect.bottom + gap + height <= window.innerHeight - 8 ? rect.bottom + gap : Math.max(8, rect.top - height - gap)
      });
    };
    place();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const label = me.user.displayName || me.user.email;
  const initials = label.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("") || "?";

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    // Sign-out is a strict POST to /auth/logout (see api.ts postLogout); never a
    // GET, so it cannot be triggered cross-site to force-log-out the user.
    await postLogout();
  };

  const menu = open ? createPortal(
    <div ref={menuRef} className="menu-popover account-popover" style={position}>
      <div className="account-popover-user">
        <strong>{label}</strong>
        {me.user.displayName && <span>{me.user.email}</span>}
        {me.organization && <span className="account-popover-org">{me.organization.name}</span>}
      </div>
      <button onClick={() => { setOpen(false); setSettingsOpen(true); }}><Settings size={15}/>Account settings</button>
      <button onClick={handleSignOut} disabled={busy}><LogOut size={15}/>{busy ? "Signing out…" : "Sign out"}</button>
    </div>,
    document.body
  ) : null;

  return (
    <div className="account-menu">
      <button ref={buttonRef} className="account-avatar" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Account menu" title={label}>{initials}</button>
      {menu}
      {settingsOpen && <AccountSettingsModal me={me} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
