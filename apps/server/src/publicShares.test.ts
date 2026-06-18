import assert from "node:assert/strict";
import test from "node:test";
import { generatePublicToken, hashPublicToken, isValidPublicToken, publicShareUrl } from "./publicShares.js";

test("public share tokens have 256 bits of URL-safe entropy and are hashed", () => {
  const token = generatePublicToken();
  assert.equal(token.length, 43);
  assert.equal(isValidPublicToken(token), true);
  assert.match(hashPublicToken(token), /^[a-f0-9]{64}$/);
  assert.equal(hashPublicToken(token).includes(token), false);
});

test("public share URLs always use the configured public origin", () => {
  const token = generatePublicToken();
  assert.equal(publicShareUrl(token), `https://modelbase.parametricstandards.com/public/${token}`);
});
