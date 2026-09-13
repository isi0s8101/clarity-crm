import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function loadIntegrationKeyring(env = process.env) {
  const configured = String(env.CLARITY_INTEGRATION_MASTER_KEYS ?? "").trim();
  const fallback = String(env.CLARITY_INTEGRATION_MASTER_KEY ?? "").trim();
  const fallbackId = String(env.CLARITY_INTEGRATION_MASTER_KEY_ID ?? "v1").trim();
  let source = {};

  if (configured) {
    let parsed;
    try {
      parsed = JSON.parse(configured);
    } catch {
      throw new Error("CLARITY_INTEGRATION_MASTER_KEYS doit être un objet JSON valide.");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("CLARITY_INTEGRATION_MASTER_KEYS doit être un objet JSON.");
    }
    source = parsed;
  } else if (fallback) {
    source = { [fallbackId]: fallback };
  } else {
    throw new Error("Clé maîtresse d'intégration absente.");
  }

  const keys = new Map();
  for (const [id, encoded] of Object.entries(source)) {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id)) throw new Error("Identifiant de clé d'intégration invalide.");
    const key = decodeKey(String(encoded));
    keys.set(id, key);
  }
  if (keys.size === 0) throw new Error("Aucune clé maîtresse d'intégration valide.");

  const activeKeyId = String(env.CLARITY_INTEGRATION_ACTIVE_KEY_ID ?? fallbackId).trim();
  if (!keys.has(activeKeyId)) throw new Error("La clé maîtresse active d'intégration est absente du keyring.");
  return { activeKeyId, keys };
}

export function encryptIntegrationValue(value, options = {}) {
  if (typeof value !== "string" || value.length === 0) throw new Error("Secret d'intégration vide.");
  const keyring = options.keyring ?? loadIntegrationKeyring(options.env);
  const keyId = options.keyId ?? keyring.activeKeyId;
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error("Clé maîtresse d'intégration introuvable.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const aad = Buffer.from(String(options.aad ?? "clarity-integration"), "utf8");
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    algorithm: ALGORITHM,
    keyId,
    ivB64: iv.toString("base64"),
    authTagB64: authTag.toString("base64"),
    ciphertextB64: ciphertext.toString("base64"),
  };
}

export function decryptIntegrationValue(envelope, options = {}) {
  if (!envelope || envelope.algorithm !== ALGORITHM) throw new Error("Envelope de secret d'intégration invalide.");
  const keyring = options.keyring ?? loadIntegrationKeyring(options.env);
  const key = keyring.keys.get(String(envelope.keyId ?? ""));
  if (!key) throw new Error("Clé de déchiffrement d'intégration indisponible.");
  const iv = decodeFixedBase64(envelope.ivB64, IV_BYTES, "IV");
  const authTag = decodeFixedBase64(envelope.authTagB64, 16, "tag GCM");
  const ciphertext = decodeBase64(envelope.ciphertextB64, "ciphertext");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(String(options.aad ?? "clarity-integration"), "utf8"));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function rotateIntegrationEnvelope(envelope, options = {}) {
  const keyring = options.keyring ?? loadIntegrationKeyring(options.env);
  if (String(envelope?.keyId ?? "") === keyring.activeKeyId) return { envelope, rotated: false };
  const plaintext = decryptIntegrationValue(envelope, { ...options, keyring });
  const rotated = encryptIntegrationValue(plaintext, { ...options, keyring, keyId: keyring.activeKeyId });
  return { envelope: rotated, rotated: true };
}

export function generatePkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function randomOpaque(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) throw new Error("Taille d'aléa invalide.");
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaque(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function safeHashEqual(expectedHex, value) {
  if (!/^[0-9a-f]{64}$/i.test(String(expectedHex))) return false;
  const actual = Buffer.from(hashOpaque(value), "hex");
  const expected = Buffer.from(String(expectedHex), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodeKey(value) {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const decoded = decodeBase64(value, "clé maîtresse");
  if (decoded.length !== KEY_BYTES) throw new Error("Une clé maîtresse d'intégration doit faire exactement 32 octets.");
  return decoded;
}

function decodeFixedBase64(value, expectedBytes, label) {
  const decoded = decodeBase64(value, label);
  if (decoded.length !== expectedBytes) throw new Error(`${label} d'intégration invalide.`);
  return decoded;
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} d'intégration invalide.`);
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new Error(`${label} d'intégration invalide.`);
  }
}
