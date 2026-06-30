import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter, clientIp, loadAuthRateLimitConfig } from "./rateLimit.js";

test("RateLimiter allows up to max hits per window, then denies", () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 3 });
  const now = 1_000_000;
  assert.equal(limiter.hit("a", now).allowed, true);
  assert.equal(limiter.hit("a", now).allowed, true);
  const third = limiter.hit("a", now);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const denied = limiter.hit("a", now);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000);
});

test("RateLimiter keys are independent", () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
  const now = 5_000;
  assert.equal(limiter.hit("a", now).allowed, true);
  assert.equal(limiter.hit("a", now).allowed, false);
  // A different key has its own budget.
  assert.equal(limiter.hit("b", now).allowed, true);
});

test("RateLimiter window resets after windowMs elapses", () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.hit("a", 0).allowed, true);
  assert.equal(limiter.hit("a", 500).allowed, false);
  // At/after resetAt the budget refreshes.
  assert.equal(limiter.hit("a", 1000).allowed, true);
});

test("RateLimiter.prune drops expired buckets", () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
  limiter.hit("a", 0);
  limiter.prune(2000);
  // Pruned, so the key gets a fresh window.
  assert.equal(limiter.hit("a", 2000).allowed, true);
});

test("clientIp prefers the first X-Forwarded-For hop", () => {
  const req: any = { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, ip: "10.0.0.1", socket: {} };
  assert.equal(clientIp(req), "203.0.113.7");
});

test("clientIp falls back to req.ip then socket address", () => {
  assert.equal(clientIp({ headers: {}, ip: "198.51.100.4", socket: {} } as any), "198.51.100.4");
  assert.equal(
    clientIp({ headers: {}, ip: undefined, socket: { remoteAddress: "192.0.2.9" } } as any),
    "192.0.2.9"
  );
});

test("loadAuthRateLimitConfig reads overrides and falls back to sane defaults", () => {
  const defaults = loadAuthRateLimitConfig({} as NodeJS.ProcessEnv);
  assert.equal(defaults.windowMs, 10 * 60 * 1000);
  assert.equal(defaults.oauthMax, 20);
  assert.equal(defaults.loginMax, 60);

  const overridden = loadAuthRateLimitConfig({
    AUTH_RATE_LIMIT_WINDOW_MS: "1000",
    AUTH_RATE_LIMIT_MAX: "3"
  } as NodeJS.ProcessEnv);
  assert.equal(overridden.windowMs, 1000);
  assert.equal(overridden.oauthMax, 3);
  // login defaults to max(oauthMax*3, 60).
  assert.equal(overridden.loginMax, 60);
});
