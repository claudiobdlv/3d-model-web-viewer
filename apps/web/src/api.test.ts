import { describe, expect, it, vi, afterEach } from "vitest";
import { getMe, postLogout } from "./api";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  const fn = vi.fn(impl as any);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getMe", () => {
  it("returns the parsed body on 200", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ authenticated: true, user: { id: "u1", email: "a@b.c", displayName: null, avatarUrl: null }, organization: null, role: "owner" })
    }));
    const me = await getMe();
    expect(me.authenticated).toBe(true);
  });

  it("treats 401 as unauthenticated", async () => {
    mockFetch(async () => ({ ok: false, status: 401, json: async () => ({ authenticated: false }) }));
    expect(await getMe()).toEqual({ authenticated: false });
  });

  it("treats 404 (accounts disabled) as unauthenticated", async () => {
    mockFetch(async () => ({ ok: false, status: 404, text: async () => "Not Found" }));
    expect(await getMe()).toEqual({ authenticated: false });
  });

  it("treats a non-JSON / invalid body as unauthenticated", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      }
    }));
    expect(await getMe()).toEqual({ authenticated: false });
  });

  it("treats a network failure as unauthenticated", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await getMe()).toEqual({ authenticated: false });
  });

  it("does not read or write web storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    mockFetch(async () => ({ ok: false, status: 401, json: async () => ({ authenticated: false }) }));
    await getMe();
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });
});

describe("postLogout", () => {
  it("signs out with POST /auth/logout and never a GET", async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, status: 302 }));
    // Avoid jsdom navigation: capture the post-logout redirect target instead.
    const hrefSetter = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { set href(value: string) { hrefSetter(value); }, get href() { return ""; } }
    });

    await postLogout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/auth/logout");
    expect(init?.method).toBe("POST");
    expect(hrefSetter).toHaveBeenCalledWith("/login");
  });

  it("does not read or write web storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    mockFetch(async () => ({ ok: true, status: 302 }));
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { set href(_v: string) {}, get href() { return ""; } }
    });
    await postLogout();
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });
});
