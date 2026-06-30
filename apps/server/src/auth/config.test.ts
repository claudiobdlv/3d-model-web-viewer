import assert from "node:assert/strict";
import test from "node:test";
import { loadAuthConfig } from "./config.js";

const GOOGLE_CREDS = { GOOGLE_CLIENT_ID: "g-client", GOOGLE_CLIENT_SECRET: "g-secret" };
const MICROSOFT_CREDS = { MICROSOFT_CLIENT_ID: "m-client", MICROSOFT_CLIENT_SECRET: "m-secret" };

test("AUTH_PROVIDERS defaults to Google-only", () => {
  const config = loadAuthConfig({ ...GOOGLE_CREDS, ...MICROSOFT_CREDS } as NodeJS.ProcessEnv);
  assert.deepEqual(config.allowedProviders, ["google"]);
  assert.ok(config.providers.google);
  // Microsoft credentials are present but Microsoft is excluded by the default
  // allow-list, so it must not be mounted/shown.
  assert.equal(config.providers.microsoft, undefined);
});

test("Microsoft requires both AUTH_PROVIDERS opt-in and credentials", () => {
  const optedIn = loadAuthConfig({
    AUTH_PROVIDERS: "google,microsoft",
    ...GOOGLE_CREDS,
    ...MICROSOFT_CREDS
  } as NodeJS.ProcessEnv);
  assert.deepEqual(optedIn.allowedProviders.sort(), ["google", "microsoft"]);
  assert.ok(optedIn.providers.microsoft);

  // Opted in but no credentials configured: still excluded.
  const noCreds = loadAuthConfig({ AUTH_PROVIDERS: "google,microsoft", ...GOOGLE_CREDS } as NodeJS.ProcessEnv);
  assert.equal(noCreds.providers.microsoft, undefined);
});

test("AUTH_PROVIDERS=microsoft alone excludes Google even with credentials", () => {
  const config = loadAuthConfig({
    AUTH_PROVIDERS: "microsoft",
    ...GOOGLE_CREDS,
    ...MICROSOFT_CREDS
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config.allowedProviders, ["microsoft"]);
  assert.equal(config.providers.google, undefined);
  assert.ok(config.providers.microsoft);
});

test("AUTH_ALLOWED_EMAILS is normalized to lowercase, trimmed, and deduplicated", () => {
  const config = loadAuthConfig({
    AUTH_ALLOWED_EMAILS: " Claudio@Example.com , other@example.com ,claudio@example.com,, "
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config.allowedAdminEmails, ["claudio@example.com", "other@example.com"]);
});

test("AUTH_ALLOWED_EMAILS unset yields an empty allow-list", () => {
  const config = loadAuthConfig({} as NodeJS.ProcessEnv);
  assert.deepEqual(config.allowedAdminEmails, []);
});
