import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db";
import { audit, authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { appendTimeline, crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";

class LoyaltyError extends Error { constructor(message: string, public status = 400) { super(message); } }

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "loyalty", "read");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const account = await getCrmRecord(actor, accountId, "read");
    if (account.type !== "loyalty_account") throw new LoyaltyError("Compte fidélité introuvable.", 404);
    const ledger = await getPool().query(
      `SELECT id, points_delta AS "pointsDelta", balance_after AS "balanceAfter", reason,
              idempotency_key AS "idempotencyKey", actor_id AS "actorId", created_at AS "createdAt"
         FROM loyalty_ledger WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at DESC LIMIT 100`,
      [actor.tenantId, accountId],
    );
    return NextResponse.json({ account, ledger: ledger.rows });
  } catch (error) {
    const authResponse = authErrorResponse(error); if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error); if (crmResponse) return crmResponse;
    if (error instanceof LoyaltyError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("loyalty:list", error);
    return NextResponse.json({ error: "Fidélité indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "loyalty", "update");
    const body = await request.json() as Record<string, unknown>;
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const delta = Number(body.pointsDelta);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim().slice(0, 180) : crypto.randomUUID();
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000_000) throw new LoyaltyError("Mouvement de points invalide.");
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(idempotencyKey)) throw new LoyaltyError("Clé d'idempotence invalide.");
    const account = await getCrmRecord(actor, accountId, "update");
    if (account.type !== "loyalty_account") throw new LoyaltyError("Compte fidélité introuvable.", 404);

    const client = await getPool().connect();
    let item: Record<string, unknown>;
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        `SELECT id, points_delta AS "pointsDelta", balance_after AS "balanceAfter", reason, idempotency_key AS "idempotencyKey", created_at AS "createdAt"
           FROM loyalty_ledger WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1`, [actor.tenantId, idempotencyKey]);
      if (prior.rows[0]) {
        item = prior.rows[0]; idempotent = true; await client.query("COMMIT");
      } else {
        const locked = await client.query(
          "SELECT data FROM crm_records WHERE tenant_id=$1 AND id=$2 AND type='loyalty_account' FOR UPDATE",
          [actor.tenantId, accountId]);
        if (!locked.rows[0]) throw new LoyaltyError("Compte fidélité introuvable.", 404);
        const data = parseData(locked.rows[0].data);
        const current = Number(data.points_balance ?? 0);
        if (!Number.isInteger(current) || current < 0) throw new LoyaltyError("Solde de fidélité incohérent.", 409);
        const next = current + delta;
        if (next < 0) throw new LoyaltyError("Solde de points insuffisant.", 409);
        data.points_balance = next;
        data.tier = next >= 5000 ? "gold" : next >= 1000 ? "silver" : "standard";
        await client.query("UPDATE crm_records SET data=$1, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$2 AND id=$3", [JSON.stringify(data), actor.tenantId, accountId]);
        const inserted = await client.query(
          `INSERT INTO loyalty_ledger(id,tenant_id,account_id,points_delta,balance_after,reason,idempotency_key,actor_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, points_delta AS "pointsDelta", balance_after AS "balanceAfter", reason, idempotency_key AS "idempotencyKey", created_at AS "createdAt"`,
          [crypto.randomUUID(), actor.tenantId, accountId, delta, next, reason, idempotencyKey, actor.userId]);
        item = inserted.rows[0];
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined); throw error;
    } finally { client.release(); }

    if (!idempotent) {
      await appendTimeline(actor, { ...account, data: { ...account.data, points_balance: item.balanceAfter } }, "loyalty.adjusted", `Fidélité ${delta > 0 ? "+" : ""}${delta} points`, item);
      await audit(actor, { action: "loyalty.adjusted", resourceType: "loyalty_account", resourceId: accountId, result: "success", details: item });
    }
    return NextResponse.json({ item, idempotent }, { status: idempotent ? 200 : 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error); if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error); if (crmResponse) return crmResponse;
    if (error instanceof LoyaltyError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("loyalty:adjust", error);
    return NextResponse.json({ error: "Mouvement de fidélité impossible." }, { status: 503 });
  }
}

function parseData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
