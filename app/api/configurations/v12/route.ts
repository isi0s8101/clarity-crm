import { NextRequest, NextResponse } from "next/server";

import { audit, authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";
import {
  getV12ConfigurationHistory,
  listV12Configurations,
  saveV12Configuration,
  setV12ConfigurationActive,
} from "@/lib/v12-config";
import { readJsonBodyLimited, v12ErrorResponse } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const historyId = request.nextUrl.searchParams.get("historyId");
    if (historyId) return NextResponse.json({ items: await getV12ConfigurationHistory(actor, historyId) });
    return NextResponse.json({ items: await listV12Configurations(actor, request.nextUrl.searchParams.get("kind")) });
  } catch (error) { return handle(error, "v12-config:list"); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const definition = asObject(body.definition);
    if (!definition) return NextResponse.json({ error: "Définition invalide." }, { status: 400 });
    const item = await saveV12Configuration(actor, {
      kind: stringValue(body.kind),
      name: stringValue(body.name),
      active: body.active !== false,
      definition,
    });
    await scheduleProactiveSweep(actor, item.kind, item.active);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return handle(error, "v12-config:create"); }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);

    if (body.restoreVersion !== undefined) {
      const id = stringValue(body.id);
      const restoreVersion = optionalInteger(body.restoreVersion);
      if (!id || restoreVersion === undefined || restoreVersion < 1) {
        return NextResponse.json({ error: "Version de restauration invalide." }, { status: 400 });
      }
      const history = await getV12ConfigurationHistory(actor, id);
      const snapshot = history.find((entry) => entry.version === restoreVersion);
      if (!snapshot) return NextResponse.json({ error: "Version de configuration introuvable." }, { status: 404 });
      const item = await saveV12Configuration(actor, {
        id,
        kind: snapshot.kind,
        name: snapshot.name,
        active: snapshot.active,
        definition: snapshot.definition,
        expectedVersion: optionalInteger(body.expectedVersion),
      });
      await audit(actor, {
        action: "crm_configuration.restored",
        resourceType: item.kind,
        resourceId: item.id,
        result: "success",
        details: { restoredFromVersion: restoreVersion, resultingVersion: item.version },
      });
      await scheduleProactiveSweep(actor, item.kind, item.active);
      return NextResponse.json({ item, restoredFromVersion: restoreVersion });
    }

    if (body.definition === undefined && typeof body.active === "boolean") {
      const item = await setV12ConfigurationActive(actor, {
        id: stringValue(body.id),
        active: body.active,
        expectedVersion: optionalInteger(body.expectedVersion),
      });
      await scheduleProactiveSweep(actor, item.kind, item.active);
      return NextResponse.json({ item });
    }
    const definition = asObject(body.definition);
    if (!definition) return NextResponse.json({ error: "Définition invalide." }, { status: 400 });
    const item = await saveV12Configuration(actor, {
      id: stringValue(body.id),
      kind: stringValue(body.kind),
      name: stringValue(body.name),
      active: body.active !== false,
      definition,
      expectedVersion: optionalInteger(body.expectedVersion),
    });
    await scheduleProactiveSweep(actor, item.kind, item.active);
    return NextResponse.json({ item });
  } catch (error) { return handle(error, "v12-config:update"); }
}

async function scheduleProactiveSweep(actor: Awaited<ReturnType<typeof resolveAuthContext>>, kind: string, active: boolean) {
  if (!active || !["inactivity_rule", "scoring_rule", "next_action_rule"].includes(kind)) return;
  const { enqueueProactiveSweepJob } = await import("@/lib/automation-queue");
  await enqueueProactiveSweepJob(actor, 0);
}

function handle(error: unknown, label: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const v12 = v12ErrorResponse(error); if (v12) return v12;
  console.error(label, error);
  return NextResponse.json({ error: "Configuration v1.2 indisponible." }, { status: 503 });
}
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function optionalInteger(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
