import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;
const PREFIX = "scrypt$v1";
const DUMMY_HASH = "scrypt$v1$16384$8$1$Y2xhcml0eS1uYXRpdmUtYQ$lar-pUgRzHggXOCBdJzu4tmwb8Vg5do6gZJ4xDl2iKrV3fJcT2td4Q2OrvcOIGtoXLrjnsrc6TlMqSmwKtZmqA";

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function validatePassword(value) {
  if (typeof value !== "string") return { ok: false, error: "Mot de passe invalide." };
  if (value.length < 12) return { ok: false, error: "Le mot de passe doit contenir au moins 12 caractères." };
  if (value.length > 256) return { ok: false, error: "Le mot de passe est trop long." };
  return { ok: true };
}

export async function hashPassword(password) {
  const validation = validatePassword(password);
  if (!validation.ok) throw new Error(validation.error);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return `${PREFIX}$${N}$${R}$${P}$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encodedHash) {
  const candidate = typeof encodedHash === "string" ? encodedHash : DUMMY_HASH;
  const parts = candidate.split("$");
  if (parts.length !== 7 || `${parts[0]}$${parts[1]}` !== PREFIX) {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }

  const [, , nValue, rValue, pValue, saltValue, hashValue] = parts;
  const n = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || r < 1 || p < 1) {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltValue, "base64url");
    expected = Buffer.from(hashValue, "base64url");
  } catch {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }
  if (salt.length < 16 || expected.length !== KEY_LENGTH) {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }

  const actual = Buffer.from(await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAX_MEM }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function hashMetadata(value) {
  if (!value) return "";
  return createHash("sha256").update(String(value).slice(0, 1024), "utf8").digest("hex");
}

export function dummyPasswordHash() {
  return DUMMY_HASH;
}
