import assert from "node:assert/strict";

import {
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  randomSessionToken,
  validatePassword,
  verifyPassword,
} from "./auth-crypto.js";

assert.equal(normalizeEmail(" Admin@Example.COM "), "admin@example.com");
assert.equal(normalizeEmail("invalid"), null);
assert.equal(validatePassword("short").ok, false);
assert.equal(validatePassword("a-secure-password-2026").ok, true);

const encoded = await hashPassword("a-secure-password-2026");
assert.match(encoded, /^scrypt\$v1\$/);
assert.equal(await verifyPassword("a-secure-password-2026", encoded), true);
assert.equal(await verifyPassword("wrong-password", encoded), false);
assert.equal(await verifyPassword("wrong-password", "invalid"), false);

const tokenA = randomSessionToken();
const tokenB = randomSessionToken();
assert.notEqual(tokenA, tokenB);
assert.equal(hashOpaqueToken(tokenA).length, 64);
assert.notEqual(hashOpaqueToken(tokenA), tokenA);

console.log("native auth crypto tests: ok");
