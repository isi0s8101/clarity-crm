import { getPool } from "@/db";
import { audit, type AuthContext } from "@/lib/authz";
import { appendTimeline, createCrmRecord, getCrmRecord } from "@/lib/crm-core";
import { evaluateAutomationConditions } from "@/lib/crm-policy.js";
import { V12ConflictError, V12ValidationError } from "@/lib/v12-planning";

type RuntimeRecord = Awaited<ReturnType<typeof getCrmRecord>>;

type ScoringFactor = {
  ruleId: string;
  ruleVersion: number;
  weight: number;
  reason: string;
  configurationId: string;
  configurationVersion: number;
};

type ScoreResult = {
  recordId: string;
  type: string;
  score: number;
  level: "low" | "medium" | "high" | "very_high";
  bounds: { min: number; max: number };
  positiveFactors: ScoringFactor[];
  negativeFactors: ScoringFactor[];
  justification: string;
  configurationVersions: Array<{ id: string; version: number }>;
  calculatedAt: string;
};

export async function calculateScore(actor: AuthContext, recordId: string, persist = true): Promise<ScoreResult> {
  const record = await getCrmRecord(actor, recordId, persist ? "update" : "read");
  if (record.type !== "lead" && record.type !== "opportunity") throw new V12ValidationError("Le scoring v1.2 cible les leads et opportunités.");
  const configs = await loadConfigs(actor.tenantId, "scoring_rule", record.type);
  if (!configs.length) throw new V12ConflictError("Aucune règle de scoring active pour ce type.");

  let min = 0;
  let max = 100;
  let score = 0;
  const positiveFactors: ScoringFactor[] = [];
  const negativeFactors: ScoringFactor[] = [];
  const configurationVersions: Array<{ id: string; version: number }> = [];
  for (const config of configs) {
    configurationVersions.push({ id: config.id, version: config.version });
    const bounds = asObject(config.definition.bounds);
    if (bounds) {
      const candidateMin = Number(bounds.min);
      const candidateMax = Number(bounds.max);
      if (Number.isFinite(candidateMin) && Number.isFinite(candidateMax) && candidateMin < candidateMax) {
        min = Math.min(min, candidateMin);
        max = Math.max(max, candidateMax);
      }
    }
    const base = Number(config.definition.baseScore ?? 0);
    if (Number.isFinite(base)) score += base;
    for (const rawRule of Array.isArray(config.definition.rules) ? config.definition.rules : []) {
      const rule = asObject(rawRule);
      if (!rule || rule.active === false) continue;
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
      if (!evaluateAutomationConditions(conditions, record)) continue;
      const weight = Number(rule.weight);
      if (!Number.isFinite(weight)) continue;
      score += weight;
      const factor: ScoringFactor = {
        ruleId: String(rule.id ?? "rule"),
        ruleVersion: integer(rule.version, 1),
        weight,
        reason: String(rule.reason ?? "Règle déterministe satisfaite.").slice(0, 240),
        configurationId: config.id,
        configurationVersion: config.version,
      };
      if (weight >= 0) positiveFactors.push(factor); else negativeFactors.push(factor);
    }
  }
  score = Math.max(min, Math.min(max, Math.round(score)));
  const ratio = max === min ? 0 : (score - min) / (max - min);
  const level: ScoreResult["level"] = ratio >= 0.75 ? "very_high" : ratio >= 0.5 ? "high" : ratio >= 0.25 ? "medium" : "low";
  const calculatedAt = new Date().toISOString();
  const justification = `${positiveFactors.length} facteur(s) positif(s), ${negativeFactors.length} facteur(s) négatif(s), calcul déterministe borné entre ${min} et ${max}.`;
  const result: ScoreResult = {
    recordId: record.id,
    type: record.type,
    score,
    level,
    bounds: { min, max },
    positiveFactors,
    negativeFactors,
    justification,
    configurationVersions,
    calculatedAt,
  };
  if (persist) await persistSystemData(actor, record, "v12Scoring", result, "scoring.recalculated", `Score ${record.type} recalculé : ${score}.`);
  return result;
}

export async function evaluateInactivity(actor: AuthContext, recordId: string, persist = true) {
  const record = await getCrmRecord(actor, recordId, persist ? "update" : "read");
  const configs = await loadConfigs(actor.tenantId, "inactivity_rule", record.type);
  if (!configs.length) {
    return { recordId: record.id, configured: false, inactive: false, dueSoonNoAction: false, reasons: [], calculatedAt: new Date().toISOString() };
  }
  const definition = configs[0].definition;
  const inactiveDays = boundedInteger(definition.inactiveDays ?? 30, 1, 3650);
  const dueSoonDays = boundedInteger(definition.dueSoonDays ?? 7, 0, 365);
  const requirePlannedAction = definition.requirePlannedAction !== false;
  const activity = await activityFacts(actor.tenantId, record);
  const now = Date.now();
  const daysSinceLastActivity = Math.floor((now - activity.lastActivityAt.getTime()) / 86_400_000);
  const inactive = daysSinceLastActivity >= inactiveDays;
  const dueDate = record.type === "opportunity" ? parseOptionalDate(record.data.closeDate ?? record.data.dueDate) : null;
  const dueInDays = dueDate ? Math.ceil((dueDate.getTime() - now) / 86_400_000) : null;
  const dueSoon = dueInDays !== null && dueInDays >= 0 && dueInDays <= dueSoonDays;
  const dueSoonNoAction = Boolean(dueSoon && requirePlannedAction && !activity.hasPlannedAction);
  const reasons: Array<{ code: string; reason: string; fact: Record<string, unknown> }> = [];
  if (inactive) reasons.push({
    code: "inactive",
    reason: `Aucune activité métier depuis ${daysSinceLastActivity} jour(s), seuil configuré ${inactiveDays}.`,
    fact: { lastActivityAt: activity.lastActivityAt.toISOString(), daysSinceLastActivity, thresholdDays: inactiveDays },
  });
  if (dueSoonNoAction) reasons.push({
    code: "due_soon_no_action",
    reason: `Échéance proche sans tâche ni rendez-vous futur détecté.`,
    fact: { dueAt: dueDate?.toISOString(), dueInDays, thresholdDays: dueSoonDays },
  });
  const result = {
    recordId: record.id,
    configured: true,
    inactive,
    dueSoonNoAction,
    thresholdDays: inactiveDays,
    dueSoonDays,
    daysSinceLastActivity,
    lastActivityAt: activity.lastActivityAt.toISOString(),
    hasPlannedAction: activity.hasPlannedAction,
    reasons,
    configuration: { id: configs[0].id, version: configs[0].version },
    calculatedAt: new Date().toISOString(),
  };
  if (persist) await persistSystemData(actor, record, "v12Inactivity", result, "inactivity.recalculated", inactive || dueSoonNoAction ? "Signal d'inactivité v1.2 détecté." : "Signal d'inactivité v1.2 recalculé.");
  return result;
}

export async function getNextActions(actor: AuthContext, recordId: string) {
  const record = await getCrmRecord(actor, recordId, "read");
  const configs = await loadConfigs(actor.tenantId, "next_action_rule", record.type);
  if (!configs.length) return { recordId: record.id, recommendations: [], calculatedAt: new Date().toISOString() };
  const inactivity = await evaluateInactivity(actor, record.id, false);
  let score: ScoreResult | null = null;
  if (record.type === "lead" || record.type === "opportunity") {
    try { score = await calculateScore(actor, record.id, false); } catch { score = null; }
  }
  const evaluationRecord = {
    ...record,
    data: {
      ...record.data,
      inactive: inactivity.inactive,
      dueSoonNoAction: inactivity.dueSoonNoAction,
      daysSinceLastActivity: inactivity.configured ? inactivity.daysSinceLastActivity : 0,
      score: score?.score,
      scoreLevel: score?.level,
    },
  };
  const recommendations = [];
  for (const config of configs) {
    for (const rawRule of Array.isArray(config.definition.rules) ? config.definition.rules : []) {
      const rule = asObject(rawRule);
      if (!rule || rule.active === false) continue;
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
      if (!evaluateAutomationConditions(conditions, evaluationRecord)) continue;
      const dueInDays = Number(rule.dueInDays ?? 0);
      recommendations.push({
        id: `${config.id}:${String(rule.id ?? "rule")}:${integer(rule.version, 1)}`,
        ruleId: String(rule.id ?? "rule"),
        ruleVersion: integer(rule.version, 1),
        configurationId: config.id,
        configurationVersion: config.version,
        action: String(rule.action ?? "review").slice(0, 120),
        object: { id: record.id, type: record.type, title: record.title },
        reason: String(rule.reason ?? "Règle déterministe satisfaite.").slice(0, 240),
        triggeringData: {
          conditions,
          inactivity: { inactive: inactivity.inactive, dueSoonNoAction: inactivity.dueSoonNoAction, daysSinceLastActivity: inactivity.configured ? inactivity.daysSinceLastActivity : null },
          score: score ? { score: score.score, level: score.level } : null,
        },
        priority: boundedInteger(rule.priority ?? 50, 1, 100),
        dueAt: Number.isFinite(dueInDays) && dueInDays >= 0 ? new Date(Date.now() + dueInDays * 86_400_000).toISOString() : null,
        requiresConfirmation: true,
      });
    }
  }
  recommendations.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return { recordId: record.id, recommendations, calculatedAt: new Date().toISOString() };
}

export async function acceptNextAction(actor: AuthContext, recordId: string, recommendationId: string) {
  const current = await getNextActions(actor, recordId);
  const recommendation = current.recommendations.find((item) => item.id === recommendationId);
  if (!recommendation) throw new V12ConflictError("La recommandation n'est plus applicable.");
  const source = await getCrmRecord(actor, recordId, "read");
  const task = await createCrmRecord(actor, {
    type: "task",
    title: recommendation.action,
    status: "active",
    data: {
      sourceRecordId: source.id,
      dueAt: recommendation.dueAt ?? undefined,
      completed: false,
      nextBestActionId: recommendation.id,
      reason: recommendation.reason,
    },
  });
  await appendTimeline(actor, source, "next_action.accepted", `Action recommandée validée : ${recommendation.action}`, {
    recommendationId: recommendation.id,
    taskId: task.id,
    reason: recommendation.reason,
  });
  await audit(actor, {
    action: "next_action.accepted",
    resourceType: source.type,
    resourceId: source.id,
    result: "success",
    details: { recommendationId: recommendation.id, taskId: task.id },
  });
  return { recommendation, task };
}

export async function refreshProactiveRecord(actor: AuthContext, recordId: string) {
  const record = await getCrmRecord(actor, recordId, "update");
  const inactivity = await evaluateInactivity(actor, record.id, true);
  let scoring: ScoreResult | null = null;
  if (record.type === "lead" || record.type === "opportunity") {
    try { scoring = await calculateScore(actor, record.id, true); } catch (error) {
      if (!(error instanceof V12ConflictError)) throw error;
    }
  }
  const nextActions = await getNextActions(actor, record.id);
  await persistSystemData(actor, record, "v12NextActions", nextActions, "next_action.recalculated", "Recommandations v1.2 recalculées.", false);
  return { recordId: record.id, inactivity, scoring, nextActions };
}

export async function refreshProactiveSweep(actor: AuthContext, limit = 500) {
  const capped = Math.min(1000, Math.max(1, limit));
  const result = await getPool().query(
    `SELECT id FROM crm_records WHERE tenant_id=$1 AND type=ANY($2::text[]) AND status<>'archived'
     ORDER BY updated_at ASC LIMIT $3`,
    [actor.tenantId, ["lead", "opportunity", "company", "contact"], capped],
  );
  const outputs = [];
  for (const row of result.rows) {
    try { outputs.push(await refreshProactiveRecord(actor, row.id)); }
    catch (error) { outputs.push({ recordId: row.id, error: error instanceof Error ? error.message : "Erreur inconnue" }); }
  }
  return { processed: outputs.length, outputs };
}

async function activityFacts(tenantId: string, record: RuntimeRecord) {
  const result = await getPool().query(
    `WITH timeline AS (
       SELECT max(created_at) AS at FROM crm_timeline_events
       WHERE tenant_id=$1 AND record_id=$2
         AND event_type NOT LIKE 'scoring.%' AND event_type NOT LIKE 'inactivity.%' AND event_type NOT LIKE 'next_action.%'
     ), linked AS (
       SELECT max(updated_at) AS at FROM crm_records r
       WHERE r.tenant_id=$1 AND r.id<>$2 AND r.type=ANY($3::text[])
         AND EXISTS (SELECT 1 FROM jsonb_each_text(r.data::jsonb) e WHERE e.value=$2)
     ), inbox AS (
       SELECT max(COALESCE(last_message_at,updated_at)) AS at FROM crm_inbox_conversations
       WHERE tenant_id=$1 AND related_record_id=$2
     )
     SELECT GREATEST($4::timestamptz, COALESCE((SELECT at FROM timeline),$4::timestamptz),
                     COALESCE((SELECT at FROM linked),$4::timestamptz), COALESCE((SELECT at FROM inbox),$4::timestamptz)) AS last_activity_at`,
    [tenantId, record.id, ["task", "appointment", "note", "intervention", "project", "ticket"], record.updatedAt],
  );
  const planned = await getPool().query(
    `SELECT EXISTS(
       SELECT 1 FROM crm_records r
       WHERE r.tenant_id=$1 AND r.status<>'archived' AND r.type IN ('task','appointment')
         AND EXISTS (SELECT 1 FROM jsonb_each_text(r.data::jsonb) e WHERE e.value=$2)
         AND ((r.type='task' AND COALESCE((r.data::jsonb->>'completed')::boolean,false)=false AND (r.data::jsonb->>'dueAt')::timestamptz>=CURRENT_TIMESTAMP)
           OR (r.type='appointment' AND (r.data::jsonb->>'startsAt')::timestamptz>=CURRENT_TIMESTAMP))
     ) AS has_planned_action`,
    [tenantId, record.id],
  );
  return {
    lastActivityAt: new Date(result.rows[0]?.last_activity_at ?? record.updatedAt),
    hasPlannedAction: Boolean(planned.rows[0]?.has_planned_action),
  };
}

async function persistSystemData(actor: AuthContext, record: RuntimeRecord, key: string, value: unknown, eventType: string, summary: string, auditChange = true) {
  const current = record.data[key];
  const nextData = { ...record.data, [key]: value };
  await getPool().query(`UPDATE crm_records SET data=$1 WHERE tenant_id=$2 AND id=$3`, [JSON.stringify(nextData), actor.tenantId, record.id]);
  record.data = nextData;
  if (JSON.stringify(current) !== JSON.stringify(value)) {
    await appendTimeline(actor, record, eventType, summary, { key });
    if (auditChange) await audit(actor, { action: eventType, resourceType: record.type, resourceId: record.id, result: "success", details: { key } });
  }
}

async function loadConfigs(tenantId: string, kind: string, targetType: string) {
  const result = await getPool().query(
    `SELECT id,version,definition FROM crm_configurations
     WHERE tenant_id=$1 AND kind=$2 AND active=1 ORDER BY updated_at DESC,id ASC LIMIT 100`,
    [tenantId, kind],
  );
  return result.rows.map((row) => ({
    id: String(row.id), version: Number(row.version), definition: asObject(parseJson(row.definition)) ?? {},
  })).filter((config) => {
    if (kind === "inactivity_rule") return Array.isArray(config.definition.targetTypes) && config.definition.targetTypes.includes(targetType);
    return config.definition.targetType === targetType;
  });
}

function parseOptionalDate(value: unknown) { if (typeof value !== "string") return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function boundedInteger(value: unknown, min: number, max: number) { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new V12ValidationError("Valeur numérique de règle invalide."); return n; }
function integer(value: unknown, fallback: number) { const n = Number(value); return Number.isInteger(n) ? n : fallback; }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return null; } }
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
