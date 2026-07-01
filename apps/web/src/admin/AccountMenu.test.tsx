import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AccountMenuSlot } from "./AccountMenu";
import type { MeResponse } from "../api";

const authed: MeResponse = {
  authenticated: true,
  user: { id: "u1", email: "ada@example.com", displayName: "Ada Lovelace", avatarUrl: null },
  organization: { id: "o1", name: "Personal Workspace", slug: "ada" },
  role: "owner",
  provider: "google"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AccountMenuSlot", () => {
  it("renders nothing when there is no session", () => {
    const { container } = render(<AccountMenuSlot me={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when unauthenticated", () => {
    const { container } = render(<AccountMenuSlot me={{ authenticated: false }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the account menu when authenticated", () => {
    render(<AccountMenuSlot me={authed} />);
    expect(screen.getByRole("button", { name: /account menu/i })).toBeInTheDocument();
  });

  it("signs out via POST /auth/logout when Sign out is clicked", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 302 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const hrefSetter = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { set href(value: string) { hrefSetter(value); }, get href() { return ""; } }
    });

    render(<AccountMenuSlot me={authed} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/auth/logout");
    expect(init.method).toBe("POST");
  });

  it("does not use localStorage/sessionStorage for the session", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    render(<AccountMenuSlot me={authed} />);
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("opens the account settings modal from the account menu", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sessions: [] }) }) as any);
    vi.stubGlobal("fetch", fetchMock);

    render(<AccountMenuSlot me={authed} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(await screen.findByRole("button", { name: /account settings/i }));

    expect(await screen.findByRole("dialog", { name: /account settings/i })).toBeInTheDocument();
  });
});
