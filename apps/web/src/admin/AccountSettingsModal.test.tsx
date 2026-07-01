import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AccountSettingsModal } from "./AccountSettingsModal";
import type { MeResponse } from "../api";

const me: Extract<MeResponse, { authenticated: true }> = {
  authenticated: true,
  user: { id: "u1", email: "ada@example.com", displayName: "Ada Lovelace", avatarUrl: null },
  organization: { id: "o1", name: "Personal Workspace", slug: "ada" },
  role: "owner",
  provider: "google"
};

function mockFetch(handlers: Record<string, () => Promise<Partial<Response>>>) {
  const fn = vi.fn(async (url: string) => {
    for (const [path, handler] of Object.entries(handlers)) {
      if (url.startsWith(path)) return handler();
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn as any);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AccountSettingsModal", () => {
  it("shows the signed-in name/email, provider, workspace, and role", async () => {
    mockFetch({
      "/api/sessions": async () => ({ ok: true, status: 200, json: async () => ({ sessions: [] }) }),
      "/api/audit-events": async () => ({ ok: false, status: 403, text: async () => "Forbidden" })
    });
    render(<AccountSettingsModal me={me} onClose={() => {}} />);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByText("Personal Workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No active sessions.")).toBeInTheDocument());
  });

  it("degrades safely (hides the security section) when the audit endpoint 403s", async () => {
    mockFetch({
      "/api/sessions": async () => ({ ok: true, status: 200, json: async () => ({ sessions: [] }) }),
      "/api/audit-events": async () => ({ ok: false, status: 403, text: async () => "Forbidden" })
    });
    render(<AccountSettingsModal me={me} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("No active sessions.")).toBeInTheDocument());
    expect(screen.queryByText(/recent security events/i)).not.toBeInTheDocument();
  });

  it("shows sessions with the current device flagged and lets you revoke another session", async () => {
    const revokeCalls: string[] = [];
    mockFetch({
      "/api/sessions/s2/revoke": async () => {
        revokeCalls.push("s2");
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      "/api/sessions": async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [
            { id: "s1", createdAt: "2026-06-01T00:00:00Z", lastUsedAt: "2026-06-30T00:00:00Z", current: true, userAgent: "A" },
            { id: "s2", createdAt: "2026-06-02T00:00:00Z", lastUsedAt: null, current: false, userAgent: "B" }
          ]
        })
      }),
      "/api/audit-events": async () => ({ ok: true, status: 200, json: async () => ({ events: [] }) })
    });
    render(<AccountSettingsModal me={me} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("This device")).toBeInTheDocument());
    expect(screen.getByText("Other device")).toBeInTheDocument();
    // Only the non-current session gets a revoke control.
    expect(screen.getAllByRole("button", { name: /revoke/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => expect(revokeCalls).toEqual(["s2"]));
    await waitFor(() => expect(screen.queryByText("Other device")).not.toBeInTheDocument());
  });

  it("shows the recent security events section for an admin/owner", async () => {
    mockFetch({
      "/api/sessions": async () => ({ ok: true, status: 200, json: async () => ({ sessions: [] }) }),
      "/api/audit-events": async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          events: [{ id: "e1", type: "login.success", createdAt: "2026-06-30T12:00:00Z", metadata: { provider: "google" } }]
        })
      })
    });
    render(<AccountSettingsModal me={me} onClose={() => {}} />);

    expect(await screen.findByText(/recent security events/i)).toBeInTheDocument();
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
  });

  it("never renders a raw session token or cookie value anywhere in the DOM", async () => {
    mockFetch({
      "/api/sessions": async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [{ id: "s1", createdAt: "2026-06-01T00:00:00Z", lastUsedAt: null, current: true, userAgent: "A" }]
        })
      }),
      "/api/audit-events": async () => ({ ok: true, status: 200, json: async () => ({ events: [] }) })
    });
    const { container } = render(<AccountSettingsModal me={me} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("This device")).toBeInTheDocument());
    expect(container.innerHTML).not.toMatch(/tokenHash|token_hash|"token"/i);
  });

  it("closes when Escape is pressed", async () => {
    mockFetch({
      "/api/sessions": async () => ({ ok: true, status: 200, json: async () => ({ sessions: [] }) }),
      "/api/audit-events": async () => ({ ok: true, status: 200, json: async () => ({ events: [] }) })
    });
    const onClose = vi.fn();
    render(<AccountSettingsModal me={me} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    // Let the in-flight sessions/audit fetches resolve before the test ends.
    await waitFor(() => expect(screen.queryByText("Loading sessions…")).not.toBeInTheDocument());
  });
});
