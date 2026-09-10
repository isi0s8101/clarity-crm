import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { invitationActivationTokens } from "@/db/auth-invitations";
import { authCredentials, invitations, users } from "@/db/schema";
import { hashOpaqueToken, hashPassword, normalizeEmail, validatePassword } from "@/lib/auth-crypto.js";
import {
  SESSION_COOKIE_NAME,
  assertSameOriginMutation,
  authenticateNativeCredentials,
  secureCookieForRequest,
} from "@/lib/native-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const body = (await request.json()) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 160) : "";
    const passwordValidation = validatePassword(password);
    if (!email || token.length < 32 || token.length > 128 || !passwordValidation.ok) {
      return NextResponse.json({ error: passwordValidation.ok ? "Invitation invalide." : passwordValidation.error }, { status: 400 });
    }

    const db = getDb();
    const tokenHash = hashOpaqueToken(token);
    const invitationRows = await db
      .select({
        invitationId: invitations.id,
        email: invitations.email,
        expiresAt: invitationActivationTokens.expiresAt,
      })
      .from(invitationActivationTokens)
      .innerJoin(invitations, eq(invitations.id, invitationActivationTokens.invitationId))
      .where(
        and(
          eq(invitationActivationTokens.tokenHash, tokenHash),
          isNull(invitationActivationTokens.consumedAt),
          eq(invitations.email, email),
          eq(invitations.status, "pending"),
        ),
      )
      .limit(1);
    const invitation = invitationRows[0];
    if (!invitation || Date.parse(invitation.expiresAt) <= Date.now()) {
      return NextResponse.json({ error: "Invitation invalide ou expirée." }, { status: 410 });
    }

    const userRows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const existingUser = userRows[0];
    if (existingUser) {
      const credentialRows = await db
        .select({ userId: authCredentials.userId })
        .from(authCredentials)
        .where(eq(authCredentials.userId, existingUser.id))
        .limit(1);
      if (credentialRows[0]) {
        await db
          .update(invitationActivationTokens)
          .set({ consumedAt: new Date().toISOString() })
          .where(and(eq(invitationActivationTokens.invitationId, invitation.invitationId), isNull(invitationActivationTokens.consumedAt)));
        return NextResponse.json({ ok: true, loginRequired: true });
      }
    }

    const userId = existingUser?.id ?? crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      if (!existingUser) {
        await tx.insert(users).values({ id: userId, email, displayName: displayName || email });
      } else if (displayName) {
        await tx.update(users).set({ displayName, updatedAt: new Date().toISOString() }).where(eq(users.id, userId));
      }
      await tx.insert(authCredentials).values({ userId, passwordHash });
      const consumed = await tx
        .update(invitationActivationTokens)
        .set({ consumedAt: new Date().toISOString() })
        .where(and(eq(invitationActivationTokens.invitationId, invitation.invitationId), isNull(invitationActivationTokens.consumedAt)))
        .returning({ invitationId: invitationActivationTokens.invitationId });
      if (!consumed[0]) throw new Error("Invitation déjà consommée.");
    });

    const session = await authenticateNativeCredentials({ email, password, userAgent: request.headers.get("user-agent") });
    const response = NextResponse.json({ ok: true, loginRequired: false, returnTo: "/" });
    response.cookies.set(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieForRequest(request),
      path: "/",
      expires: new Date(session.expiresAt),
      priority: "high",
    });
    return response;
  } catch (error) {
    console.error("auth:activate", error);
    return NextResponse.json({ error: "Activation impossible." }, { status: 503 });
  }
}
