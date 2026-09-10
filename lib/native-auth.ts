import { and, eq, isNull, lte } from "drizzle-orm";

import { getDb } from "@/db";
import { authCredentials, authLoginAttempts, authSessions, users } from "@/db/schema";
import {
  dummyPasswordHash,
  hashMetadata,
  hashOpaqueToken,
  normalizeEmail,
  randomSessionToken,
  verifyPassword,
} from "./auth-crypto.js";

export const SESSION_COOKIE_NAME = "clarity_session";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const SESSION_TOUCH_MS = 5 * 60 * 1000;

export type NativeIdentity = {
  userId: string;
  email: string;
  displayName: string;
};

export class NativeAuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
  }
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sessionTtlMs() {
  return boundedInteger(process.env.CLARITY_SESSION_TTL_HOURS, 12, 1, 168) * 60 * 60 * 1000;
}

function cookieValue(headers: Headers, name: string) {
  const cookieHeader = headers.get("cookie") ?? "";
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export async function authenticateNativeCredentials(input: {
  email: unknown;
  password: unknown;
  userAgent?: string | null;
}) {
  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || password.length < 1 || password.length > 256) {
    throw new NativeAuthError("Identifiants invalides.", 401);
  }

  const db = getDb();
  const now = new Date();
  const keyHash = hashOpaqueToken(`login:${email}`);
  const attemptRows = await db
    .select()
    .from(authLoginAttempts)
    .where(eq(authLoginAttempts.keyHash, keyHash))
    .limit(1);
  const attempt = attemptRows[0];
  if (attempt?.blockedUntil && Date.parse(attempt.blockedUntil) > now.getTime()) {
    throw new NativeAuthError("Trop de tentatives. Réessayez plus tard.", 429);
  }

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: authCredentials.passwordHash,
    })
    .from(users)
    .leftJoin(authCredentials, eq(authCredentials.userId, users.id))
    .where(eq(users.email, email))
    .limit(1);
  const row = rows[0];

  const valid = await verifyPassword(password, row?.passwordHash ?? dummyPasswordHash());
  if (!row || !row.passwordHash || !valid) {
    const windowStarted = attempt?.windowStartedAt ? Date.parse(attempt.windowStartedAt) : 0;
    const withinWindow = Number.isFinite(windowStarted) && now.getTime() - windowStarted < LOGIN_WINDOW_MS;
    const failures = withinWindow ? Number(attempt?.failures ?? 0) + 1 : 1;
    const blockedUntil = failures >= MAX_LOGIN_FAILURES
      ? new Date(now.getTime() + LOGIN_BLOCK_MS).toISOString()
      : null;

    await db
      .insert(authLoginAttempts)
      .values({
        keyHash,
        failures,
        windowStartedAt: withinWindow && attempt ? attempt.windowStartedAt : now.toISOString(),
        blockedUntil,
        updatedAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: authLoginAttempts.keyHash,
        set: {
          failures,
          windowStartedAt: withinWindow && attempt ? attempt.windowStartedAt : now.toISOString(),
          blockedUntil,
          updatedAt: now.toISOString(),
        },
      });

    throw new NativeAuthError("Identifiants invalides.", failures >= MAX_LOGIN_FAILURES ? 429 : 401);
  }

  await db.delete(authLoginAttempts).where(eq(authLoginAttempts.keyHash, keyHash));
  await db.delete(authSessions).where(lte(authSessions.expiresAt, now.toISOString()));

  const token = randomSessionToken();
  const expiresAt = new Date(now.getTime() + sessionTtlMs()).toISOString();
  await db.insert(authSessions).values({
    id: hashOpaqueToken(token),
    userId: row.userId,
    userAgentHash: hashMetadata(input.userAgent ?? ""),
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt,
  });

  return {
    token,
    expiresAt,
    user: {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
    } satisfies NativeIdentity,
  };
}

export async function readNativeIdentity(request: { headers: Headers }): Promise<NativeIdentity | null> {
  const token = cookieValue(request.headers, SESSION_COOKIE_NAME);
  if (!token || token.length < 32 || token.length > 128) return null;

  const sessionId = hashOpaqueToken(token);
  const db = getDb();
  const rows = await db
    .select({
      sessionId: authSessions.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      lastSeenAt: authSessions.lastSeenAt,
      expiresAt: authSessions.expiresAt,
      revokedAt: authSessions.revokedAt,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  const expires = Date.parse(row.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    await db.delete(authSessions).where(eq(authSessions.id, sessionId));
    return null;
  }

  const lastSeen = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(lastSeen) || now - lastSeen >= SESSION_TOUCH_MS) {
    await db
      .update(authSessions)
      .set({ lastSeenAt: new Date(now).toISOString() })
      .where(eq(authSessions.id, sessionId));
  }

  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
  };
}

export async function revokeNativeSession(request: { headers: Headers }) {
  const token = cookieValue(request.headers, SESSION_COOKIE_NAME);
  if (!token) return;
  await getDb()
    .update(authSessions)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(authSessions.id, hashOpaqueToken(token)));
}

export function secureCookieForRequest(request: { nextUrl: URL; headers: Headers }) {
  const configured = process.env.CLARITY_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "1" || configured === "true" || configured === "yes") return true;
  if (configured === "0" || configured === "false" || configured === "no") return false;
  if (request.nextUrl.protocol === "https:") return true;
  if (process.env.CLARITY_TRUST_PROXY === "1") {
    return request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return false;
}

export function assertSameOriginMutation(request: { headers: Headers; nextUrl: URL }) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw new NativeAuthError("Origine de requête refusée.", 403);
  }

  const origin = request.headers.get("origin");
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new NativeAuthError("Origine de requête refusée.", 403);
  }
  if (parsed.origin !== request.nextUrl.origin) {
    throw new NativeAuthError("Origine de requête refusée.", 403);
  }
}

export function safeReturnPath(value: unknown, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, "https://clarity.local");
    if (url.origin !== "https://clarity.local") return fallback;
    if (url.pathname === "/login" || url.pathname.startsWith("/api/auth/")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
