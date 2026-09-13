import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { createCrmRecord, crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { calculateCommercialDocument } from "@/lib/crm-policy.js";
import { assertSameOriginMutation } from "@/lib/native-auth";

class CpqError extends Error { constructor(message: string, public status = 400) { super(message); } }

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "cpq", "create");
    const body = await request.json() as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    const company = await getCrmRecord(actor, companyId, "read");
    if (company.type !== "company") throw new CpqError("Société invalide.");
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) throw new CpqError("Le CPQ doit contenir entre 1 et 100 éléments.");

    const lines: Array<Record<string, unknown>> = [];
    let currency = "";
    for (const raw of body.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CpqError("Élément CPQ invalide.");
      const item = raw as Record<string, unknown>;
      const recordId = typeof item.recordId === "string" ? item.recordId : "";
      const quantity = Number(item.quantity);
      const taxRateBasisPoints = item.taxRateBasisPoints === undefined ? 0 : Number(item.taxRateBasisPoints);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) throw new CpqError("Quantité CPQ invalide.");
      const source = await getCrmRecord(actor, recordId, "read");
      if (source.type !== "product" && source.type !== "service") throw new CpqError("Seuls les produits et services sont autorisés.");
      const unitPriceCents = Number(source.data.unitPriceCents);
      const sourceCurrency = typeof source.data.currency === "string" ? source.data.currency : "EUR";
      if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) throw new CpqError(`Prix serveur invalide pour ${source.title}.`, 409);
      if (currency && currency !== sourceCurrency) throw new CpqError("Les éléments CPQ doivent partager la même devise.", 409);
      currency = sourceCurrency;
      lines.push({ description: source.title, quantity, unitPriceCents, taxRateBasisPoints, sourceItemId: source.id, sourceType: source.type });
    }

    const calculated = calculateCommercialDocument({ currency: currency || "EUR", lines });
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 160) : `Devis ${company.title}`;
    const quote = await createCrmRecord(actor, { type: "quote", title, data: { companyId, ...calculated } });
    return NextResponse.json({ item: quote }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error); if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error); if (crmResponse) return crmResponse;
    if (error instanceof CpqError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("cpq:create", error);
    return NextResponse.json({ error: "Calcul CPQ impossible." }, { status: 503 });
  }
}
