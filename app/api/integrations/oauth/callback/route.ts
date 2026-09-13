import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db";
import { authErrorResponse, readAuthenticatedIdentity, resolveAuthContext } from "@/lib/authz";
import { hashOpaque } from "@/lib/integration-crypto.mjs";
import { completeIntegrationAuthorization, integrationErrorResponse } from "@/lib/integration-manager";

export async function GET(request: NextRequest) {
  try {
    const providerError = request.nextUrl.searchParams.get("error");
    if (providerError) return NextResponse.json({ error: "Autorisation refusée par le fournisseur." }, { status: 400 });
    const state = request.nextUrl.searchParams.get("state") ?? "";
    const code = request.nextUrl.searchParams.get("code") ?? "";
    if (state.length < 8 || state.length > 2048 || code.length < 8 || code.length > 8192) {
      return NextResponse.json({ error: "Callback OAuth invalide." }, { status: 400 });
    }

    const tx = await getPool().query(
      `SELECT tenant_id,initiated_by FROM integration_oauth_transactions
       WHERE state_hash=$1 AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP LIMIT 1`,
      [hashOpaque(state)],
    );
    const transaction = tx.rows[0];
    if (!transaction) return NextResponse.json({ error: "Contexte OAuth invalide ou expiré." }, { status: 400 });

    const identity = await readAuthenticatedIdentity(request);
    if (identity.userId !== transaction.initiated_by) {
      return NextResponse.json({ error: "Identité OAuth incohérente." }, { status: 403 });
    }

    const headers = new Headers(request.headers);
    headers.set("x-clarity-tenant-id", String(transaction.tenant_id));
    const actor = await resolveAuthContext({ headers });
    const item = await completeIntegrationAuthorization(actor, { state, code });
    const target = new URL("/", request.url);
    target.searchParams.set("integrationAuth", "success");
    target.searchParams.set("connectionId", item.id);
    return NextResponse.redirect(target, 303);
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const integration = integrationErrorResponse(error); if (integration) return integration;
    console.error("integrations:oauth-callback", error);
    return NextResponse.json({ error: "Callback OAuth indisponible." }, { status: 503 });
  }
}
