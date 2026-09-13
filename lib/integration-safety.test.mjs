import assert from "node:assert/strict";
import {
  assertNoSensitiveIntegrationKeys,
  isSensitiveIntegrationKey,
  sanitizeIntegrationDetails,
} from "./integration-safety.mjs";

assert.deepEqual(assertNoSensitiveIntegrationKeys({ clientId: "public-id", mapping: { email: "mail" } }), { clientId: "public-id", mapping: { email: "mail" } });
assert.throws(() => assertNoSensitiveIntegrationKeys({ nested: { refresh_token: "x" } }), /clé sensible interdite/);
assert.throws(() => assertNoSensitiveIntegrationKeys({ items: [{ clientSecret: "x" }] }), /clé sensible interdite/);
assert.equal(isSensitiveIntegrationKey("Authorization"), true);
assert.equal(isSensitiveIntegrationKey("clientId"), false);
assert.deepEqual(
  sanitizeIntegrationDetails({ provider: { authorization: "Bearer x", code: "429" }, accessToken: "abc", nested: [{ password: "pw", ok: true }] }),
  { provider: { authorization: "[REDACTED]", code: "429" }, accessToken: "[REDACTED]", nested: [{ password: "[REDACTED]", ok: true }] },
);
console.log("INTEGRATION_SAFETY=OK");
