import assert from "node:assert/strict";
import {
  decryptIntegrationValue,
  encryptIntegrationValue,
  generatePkcePair,
  hashOpaque,
  loadIntegrationKeyring,
  rotateIntegrationEnvelope,
  safeHashEqual,
} from "./integration-crypto.mjs";

const envV1 = {
  CLARITY_INTEGRATION_MASTER_KEYS: JSON.stringify({
    v1: "11".repeat(32),
  }),
  CLARITY_INTEGRATION_ACTIVE_KEY_ID: "v1",
};
const keyringV1 = loadIntegrationKeyring(envV1);
const aad = "tenant-a:connection-a:refresh_token";
const encrypted = encryptIntegrationValue("refresh-secret-value", { keyring: keyringV1, aad });
assert.equal(encrypted.algorithm, "aes-256-gcm");
assert.equal(encrypted.keyId, "v1");
assert.notEqual(encrypted.ciphertextB64, "refresh-secret-value");
assert.equal(decryptIntegrationValue(encrypted, { keyring: keyringV1, aad }), "refresh-secret-value");
assert.throws(() => decryptIntegrationValue(encrypted, { keyring: keyringV1, aad: "wrong-aad" }));

const envV2 = {
  CLARITY_INTEGRATION_MASTER_KEYS: JSON.stringify({
    v1: "11".repeat(32),
    v2: "22".repeat(32),
  }),
  CLARITY_INTEGRATION_ACTIVE_KEY_ID: "v2",
};
const keyringV2 = loadIntegrationKeyring(envV2);
const rotation = rotateIntegrationEnvelope(encrypted, { keyring: keyringV2, aad });
assert.equal(rotation.rotated, true);
assert.equal(rotation.envelope.keyId, "v2");
assert.equal(decryptIntegrationValue(rotation.envelope, { keyring: keyringV2, aad }), "refresh-secret-value");

const pkce = generatePkcePair();
assert.ok(pkce.verifier.length >= 43);
assert.equal(pkce.method, "S256");
assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(pkce.verifier, pkce.challenge);

const state = "state-value";
const stateHash = hashOpaque(state);
assert.match(stateHash, /^[0-9a-f]{64}$/);
assert.equal(safeHashEqual(stateHash, state), true);
assert.equal(safeHashEqual(stateHash, "other"), false);

assert.throws(() => loadIntegrationKeyring({}), /Clé maîtresse/);
assert.throws(() => loadIntegrationKeyring({
  CLARITY_INTEGRATION_MASTER_KEYS: JSON.stringify({ v1: "short" }),
  CLARITY_INTEGRATION_ACTIVE_KEY_ID: "v1",
}), /32 octets/);

console.log("INTEGRATION_CRYPTO=OK");
