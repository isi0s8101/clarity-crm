import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { automationRuns, crmConfigurations } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import { runAutomations, type AutomationEvent } from "@/lib/automation";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";

const allowedEvents = new Set<AutomationEvent>([
  "record.created",
  "record.updated",
  "record.archived",
  "record.status_changed",
  "record.pipeline_changed",
]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "automation", "read");
    const db = getDb();
    const [configs, runs] = await Promise.all([
      db
        .select()
        .from(crmConfigurations)
        .where(
          and(
            eq(crmConfigurations.tenantId, actor.tenantId),
            eq(crmConfigurations.kind, "automation"),
          ),
        )
        .orderBy(desc(crmConfigurations.updatedAt))
        .limit(100),
      db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.tenantId, actor.tenantId))
        .orderBy(desc(automationRuns.createdAt))
        .limit(100),
    ]);
    return NextResponse.json({
      configurations: configs.map((config) => ({
        ...config,
        active: config.active === 1,
        definition: safeJson(config.definition),
      })),
      runs: runs.map((run) => ({
        ...run,
        input: safeJson(run.input),
        output: safeJson(run.output),
      })),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("automations:list", error);
    return NextResponse.json({ error: "Automatisations indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "automation", "administer");
    const body = (await request.json()) as Record<string, unknown>;
    const recordId = typeof body.recordId === "string" ? body.recordId : "";
    const event = typeof body.event === "string" ? body.event as AutomationEvent : "record.updated";
    if (!allowedEvents.has(event)) {
      return NextResponse.json({ error: "Événement invalide." }, { status: 400 });
    }
    const record = await getCrmRecord(actor, recordId, "read");
    await runAutomations(actor, event, record);
    await audit(actor, {
      action: "automation.replayed",
      resourceType: record.type,
      resourceId: record.id,
      result: "success",
      details: { event },
    });
    return NextResponse.json({ executed: true });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("automations:replay", error);
    return NextResponse.json({ error: "Exécution d'automatisation impossible." }, { status: 503 });
  }
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
