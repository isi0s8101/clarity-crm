import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db";
import { audit, authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { appendTimeline, crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { createNotification } from "@/lib/notifications";
import { assertSameOriginMutation } from "@/lib/native-auth";

class InventoryError extends Error { constructor(message: string, public status = 400) { super(message); } }

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const scope = await requirePermission(actor, "inventory", "read");
    const productId = request.nextUrl.searchParams.get("productId") ?? "";
    const locationId = request.nextUrl.searchParams.get("locationId") ?? "";
    const params: unknown[] = [actor.tenantId];
    const filters = ["b.tenant_id=$1"];
    if (scope === "team") { params.push(actor.teamId); filters.push(`p.team_id=$${params.length}`, `l.team_id=$${params.length}`); }
    if (scope === "personal") { params.push(actor.userId); filters.push(`p.owner_id=$${params.length}`, `l.owner_id=$${params.length}`); }
    if (productId) { params.push(productId); filters.push(`b.product_id=$${params.length}`); }
    if (locationId) { params.push(locationId); filters.push(`b.location_id=$${params.length}`); }
    const balances = await getPool().query(
      `SELECT b.tenant_id AS "tenantId", b.product_id AS "productId", p.title AS "productTitle",
              b.location_id AS "locationId", l.title AS "locationTitle", b.quantity, b.threshold,
              (b.quantity <= b.threshold) AS "belowThreshold", b.updated_at AS "updatedAt"
         FROM inventory_balances b
         JOIN crm_records p ON p.tenant_id=b.tenant_id AND p.id=b.product_id AND p.type='product'
         JOIN crm_records l ON l.tenant_id=b.tenant_id AND l.id=b.location_id AND l.type='stock_location'
        WHERE ${filters.join(" AND ")} ORDER BY p.title, l.title LIMIT 500`, params);
    const movements = productId && locationId
      ? await getPool().query(
        `SELECT id, product_id AS "productId", location_id AS "locationId", quantity_delta AS "quantityDelta",
                quantity_after AS "quantityAfter", reason, idempotency_key AS "idempotencyKey", actor_id AS "actorId", created_at AS "createdAt"
           FROM inventory_movements WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3 ORDER BY created_at DESC LIMIT 100`,
        [actor.tenantId, productId, locationId])
      : { rows: [] };
    return NextResponse.json({ balances: balances.rows, movements: movements.rows });
  } catch (error) {
    const authResponse = authErrorResponse(error); if (authResponse) return authResponse;
    console.error("inventory:list", error);
    return NextResponse.json({ error: "Stock indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "inventory", "update");
    const body = await request.json() as Record<string, unknown>;
    const productId = typeof body.productId === "string" ? body.productId : "";
    const locationId = typeof body.locationId === "string" ? body.locationId : "";
    const delta = Number(body.quantityDelta);
    const threshold = body.threshold === undefined ? null : Number(body.threshold);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim().slice(0, 180) : crypto.randomUUID();
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw new InventoryError("Mouvement de stock invalide.");
    if (threshold !== null && (!Number.isInteger(threshold) || threshold < 0 || threshold > 1_000_000)) throw new InventoryError("Seuil de stock invalide.");
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(idempotencyKey)) throw new InventoryError("Clé d'idempotence invalide.");
    const product = await getCrmRecord(actor, productId, "read");
    const location = await getCrmRecord(actor, locationId, "read");
    if (product.type !== "product" || location.type !== "stock_location") throw new InventoryError("Produit ou emplacement invalide.");

    const client = await getPool().connect();
    let output: Record<string, unknown>;
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        `SELECT id, product_id AS "productId", location_id AS "locationId", quantity_delta AS "quantityDelta", quantity_after AS "quantityAfter", reason, idempotency_key AS "idempotencyKey", created_at AS "createdAt"
           FROM inventory_movements WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1`, [actor.tenantId, idempotencyKey]);
      if (prior.rows[0]) {
        output = prior.rows[0]; idempotent = true; await client.query("COMMIT");
      } else {
        await client.query(
          `INSERT INTO inventory_balances(tenant_id, product_id, location_id, quantity, threshold)
           VALUES ($1,$2,$3,0,$4) ON CONFLICT (tenant_id, product_id, location_id) DO NOTHING`,
          [actor.tenantId, productId, locationId, threshold ?? 0]);
        const locked = await client.query(
          "SELECT quantity, threshold FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3 FOR UPDATE",
          [actor.tenantId, productId, locationId]);
        const current = Number(locked.rows[0]?.quantity ?? 0);
        const currentThreshold = Number(locked.rows[0]?.threshold ?? 0);
        const next = current + delta;
        if (next < 0) throw new InventoryError("Stock insuffisant.", 409);
        const nextThreshold = threshold ?? currentThreshold;
        await client.query(
          "UPDATE inventory_balances SET quantity=$1, threshold=$2, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$3 AND product_id=$4 AND location_id=$5",
          [next, nextThreshold, actor.tenantId, productId, locationId]);
        const movement = await client.query(
          `INSERT INTO inventory_movements(id,tenant_id,product_id,location_id,quantity_delta,quantity_after,reason,idempotency_key,actor_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, product_id AS "productId", location_id AS "locationId", quantity_delta AS "quantityDelta", quantity_after AS "quantityAfter", reason, idempotency_key AS "idempotencyKey", created_at AS "createdAt"`,
          [crypto.randomUUID(), actor.tenantId, productId, locationId, delta, next, reason, idempotencyKey, actor.userId]);
        output = { ...movement.rows[0], threshold: nextThreshold, belowThreshold: next <= nextThreshold };
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined); throw error;
    } finally { client.release(); }

    if (!idempotent) {
      await appendTimeline(actor, product, "inventory.moved", `Stock ${delta > 0 ? "+" : ""}${delta} · ${location.title}`, output);
      await audit(actor, { action: "inventory.moved", resourceType: "product", resourceId: product.id, result: "success", details: output });
      if (output.belowThreshold === true) {
        await createNotification({ tenantId: actor.tenantId, recipientId: actor.userId, type: "stock.threshold", message: `Seuil de stock atteint : ${product.title}`, resourceType: "product", resourceId: product.id });
      }
    }
    return NextResponse.json({ item: output, idempotent }, { status: idempotent ? 200 : 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error); if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error); if (crmResponse) return crmResponse;
    if (error instanceof InventoryError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return NextResponse.json({ error: "Mouvement déjà traité." }, { status: 409 });
    console.error("inventory:move", error);
    return NextResponse.json({ error: "Mouvement de stock impossible." }, { status: 503 });
  }
}
