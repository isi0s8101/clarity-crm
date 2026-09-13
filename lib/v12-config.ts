import { getPool } from "@/db";
import { audit, requirePermission, type AuthContext } from "@/lib/authz";
import { normalizeAvailabilityDefinition, V12ConflictError, V12NotFoundError, V12ValidationError } from "@/lib/v12-planning";

export const V12_CONFIG_KINDS = [
  "availability",
  "duplicate_rule",
  "scoring_rule",
  "inactivity_rule",
  "next_action_rule",
] as const;

export type V12ConfigKind = (typeof V12_CONFIG_KINDS)[number];

const KEY_RE = /^[a-z][a-z0-9_-]{0,49}$/;
const ID_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const OPERATORS = new Set(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists"]);

export async function listV12Configurations(actor: AuthContext, kind?: string | null) {
  await requirePermission(actor, "crm_configuration", "read");
  const normalizedKind = kind ? normalizeKind(kind) : null;
  const values: unknown[] = [actor.tenantId];
  let kindSql = "";
  if (normalizedKind) {
    values.push(normalizedKind);
    kindSql = ` AND kind=$${values.length}`;
  } else {
    values.push([...V12_CONFIG_KINDS]);
    kindSql = ` AND kind=ANY($${values.length}::text[])`;
  }
  const result = await getPool().query(
    `SELECT id,kind,name,version,active,definition,created_at,updated_at
     FROM crm_configurations WHERE tenant_id=$1${kindSql}
     ORDER BY kind,name,version DESC LIMIT 500`,
    values,
  );
  return result.rows.map(decodeConfiguration);
}

export async function getV12ConfigurationHistory(actor: AuthContext, configurationId: string) {
  await requirePermission(actor, "crm_configuration", "administer");
  const result = await getPool().query(
    `SELECT v.id,c.kind,v.configuration_id,v.version,v.name,v.active,v.definition,v.created_by,v.created_at
     FROM crm_configuration_versions v
     JOIN crm_configurations c ON c.tenant_id=v.tenant_id AND c.id=v.configuration_id
     WHERE v.tenant_id=$1 AND v.configuration_id=$2 AND c.kind=ANY($3::text[])
     ORDER BY v.version DESC LIMIT 100`,
    [actor.tenantId, configurationId, [...V12_CONFIG_KINDS]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    configurationId: row.configuration_id,
    version: Number(row.version),
    name: row.name,
    active: Number(row.active) === 1,
    definition: asObject(parseJson(row.definition)) ?? {},
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function saveV12Configuration(actor: AuthContext, input: {
  id?: string;
  kind: string;
  name: string;
  active?: boolean;
  definition: Record<string, unknown>;
  expectedVersion?: number;
}) {
  await requirePermission(actor, "crm_configuration", "administer");
  const kind = normalizeKind(input.kind);
  const name = normalizeName(input.name);
  const definition = validateV12Configuration(kind, input.definition);
  const active = input.active === false ? 0 : 1;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (!input.id) {
      const id = crypto.randomUUID();
      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO crm_configurations(id,tenant_id,kind,name,version,active,definition)
           VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING *`,
          [id, actor.tenantId, kind, name, active, JSON.stringify(definition)],
        );
      } catch (error) {
        if ((error as { code?: unknown })?.code === "23505") throw new V12ConflictError("Une règle portant cette clé existe déjà.");
        throw error;
      }
      await client.query(
        `INSERT INTO crm_configuration_versions(id,tenant_id,configuration_id,version,name,active,definition,created_by)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
        [`${id}:1`, actor.tenantId, id, name, active, JSON.stringify(definition), actor.userId],
      );
      await client.query("COMMIT");
      const item = decodeConfiguration(inserted.rows[0]);
      await audit(actor, { action: "crm_configuration.created", resourceType: kind, resourceId: id, result: "success", after: item });
      return item;
    }

    const existingResult = await client.query(
      `SELECT * FROM crm_configurations WHERE tenant_id=$1 AND id=$2 AND kind=ANY($3::text[]) FOR UPDATE`,
      [actor.tenantId, input.id, [...V12_CONFIG_KINDS]],
    );
    const existing = existingResult.rows[0];
    if (!existing) throw new V12NotFoundError("Configuration v1.2 introuvable.");
    if (existing.kind !== kind) throw new V12ConflictError("Le type d'une configuration est immuable.");
    const oldDefinition = asObject(parseJson(existing.definition)) ?? {};
    if (oldDefinition.key !== definition.key) throw new V12ConflictError("La clé d'une configuration est immuable.");
    if (input.expectedVersion !== undefined && Number(existing.version) !== input.expectedVersion) {
      throw new V12ConflictError("Configuration modifiée simultanément, recharge requise.");
    }
    const nextVersion = Number(existing.version) + 1;
    const updated = await client.query(
      `UPDATE crm_configurations SET name=$1,version=$2,active=$3,definition=$4,updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$5 AND id=$6 RETURNING *`,
      [name, nextVersion, active, JSON.stringify(definition), actor.tenantId, input.id],
    );
    await client.query(
      `INSERT INTO crm_configuration_versions(id,tenant_id,configuration_id,version,name,active,definition,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [`${input.id}:${nextVersion}`, actor.tenantId, input.id, nextVersion, name, active, JSON.stringify(definition), actor.userId],
    );
    await client.query("COMMIT");
    const before = decodeConfiguration(existing);
    const item = decodeConfiguration(updated.rows[0]);
    await audit(actor, { action: "crm_configuration.updated", resourceType: kind, resourceId: input.id, result: "success", before, after: item });
    return item;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setV12ConfigurationActive(actor: AuthContext, input: { id: string; active: boolean; expectedVersion?: number }) {
  await requirePermission(actor, "crm_configuration", "administer");
  const existing = await getPool().query(
    `SELECT * FROM crm_configurations WHERE tenant_id=$1 AND id=$2 AND kind=ANY($3::text[]) LIMIT 1`,
    [actor.tenantId, input.id, [...V12_CONFIG_KINDS]],
  );
  if (!existing.rows[0]) throw new V12NotFoundError("Configuration v1.2 introuvable.");
  const row = existing.rows[0];
  return saveV12Configuration(actor, {
    id: row.id,
    kind: row.kind,
    name: row.name,
    active: input.active,
    definition: asObject(parseJson(row.definition)) ?? {},
    expectedVersion: input.expectedVersion,
  });
}

export function validateV12Configuration(kind: V12ConfigKind, raw: Record<string, unknown>) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new V12ValidationError("Définition v1.2 invalide.");
  const definition = structuredClone(raw);
  const key = definition.key;
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new V12ValidationError("Clé de configuration v1.2 invalide.");

  if (kind === "availability") {
    return normalizeAvailabilityDefinition(definition) as unknown as Record<string, unknown>;
  }
  if (kind === "duplicate_rule") validateDuplicateRule(definition);
  if (kind === "scoring_rule") validateScoringRule(definition);
  if (kind === "inactivity_rule") validateInactivityRule(definition);
  if (kind === "next_action_rule") validateNextActionRule(definition);
  if (JSON.stringify(definition).length > 131072) throw new V12ValidationError("Configuration v1.2 trop volumineuse.");
  return definition;
}

function validateDuplicateRule(definition: Record<string, unknown>) {
  const targetType = definition.targetType;
  if (!["contact", "company", "lead", "opportunity"].includes(String(targetType))) {
    throw new V12ValidationError("Type cible de détection de doublons invalide.");
  }
  const criteria = Array.isArray(definition.criteria) ? definition.criteria : [];
  if (criteria.length < 1 || criteria.length > 20) throw new V12ValidationError("Critères de doublon invalides.");
  const kinds = new Set(["email", "phone", "company_name", "name_address", "name_email", "business_id"]);
  const ids = new Set<string>();
  for (const raw of criteria) {
    const item = asObject(raw);
    if (!item || typeof item.id !== "string" || !ID_RE.test(item.id) || ids.has(item.id)) throw new V12ValidationError("Identifiant de critère de doublon invalide ou dupliqué.");
    ids.add(item.id);
    if (!kinds.has(String(item.kind))) throw new V12ValidationError("Critère de doublon inconnu.");
    if (item.kind === "business_id" && (typeof item.field !== "string" || !FIELD_RE.test(item.field))) throw new V12ValidationError("Champ d'identifiant métier invalide.");
    if (item.weight !== undefined) boundedInteger(item.weight, 1, 100, "Poids de doublon invalide.");
    if (typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 240) throw new V12ValidationError("Justification de doublon invalide.");
  }
}

function validateScoringRule(definition: Record<string, unknown>) {
  if (!["lead", "opportunity"].includes(String(definition.targetType))) throw new V12ValidationError("Type cible de scoring invalide.");
  const bounds = asObject(definition.bounds) ?? { min: 0, max: 100 };
  const min = Number(bounds.min ?? 0);
  const max = Number(bounds.max ?? 100);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || min < -100000 || max > 100000) throw new V12ValidationError("Bornes de scoring invalides.");
  const rules = Array.isArray(definition.rules) ? definition.rules : [];
  if (rules.length < 1 || rules.length > 100) throw new V12ValidationError("Règles de scoring invalides.");
  const ids = new Set<string>();
  for (const raw of rules) {
    const rule = asObject(raw);
    if (!rule || typeof rule.id !== "string" || !ID_RE.test(rule.id) || ids.has(rule.id)) throw new V12ValidationError("Identifiant de règle de scoring invalide ou dupliqué.");
    ids.add(rule.id);
    boundedInteger(rule.version ?? 1, 1, 100000, "Version de règle invalide.");
    boundedInteger(rule.weight, -10000, 10000, "Poids de scoring invalide.");
    if (rule.active !== undefined && typeof rule.active !== "boolean") throw new V12ValidationError("État de règle de scoring invalide.");
    if (typeof rule.reason !== "string" || !rule.reason.trim() || rule.reason.length > 240) throw new V12ValidationError("Justification de scoring invalide.");
    validateConditions(rule.conditions);
  }
}

function validateInactivityRule(definition: Record<string, unknown>) {
  const targetTypes = Array.isArray(definition.targetTypes) ? definition.targetTypes : [];
  if (!targetTypes.length || targetTypes.length > 5 || targetTypes.some((type) => !["lead", "opportunity", "company", "contact"].includes(String(type)))) {
    throw new V12ValidationError("Types d'inactivité invalides.");
  }
  boundedInteger(definition.inactiveDays ?? 30, 1, 3650, "Seuil d'inactivité invalide.");
  boundedInteger(definition.dueSoonDays ?? 7, 0, 365, "Fenêtre d'échéance invalide.");
  if (definition.requirePlannedAction !== undefined && typeof definition.requirePlannedAction !== "boolean") throw new V12ValidationError("Politique d'action planifiée invalide.");
}

function validateNextActionRule(definition: Record<string, unknown>) {
  if (!["lead", "opportunity", "company", "contact"].includes(String(definition.targetType))) throw new V12ValidationError("Type cible NBA invalide.");
  const rules = Array.isArray(definition.rules) ? definition.rules : [];
  if (!rules.length || rules.length > 100) throw new V12ValidationError("Règles NBA invalides.");
  const ids = new Set<string>();
  for (const raw of rules) {
    const rule = asObject(raw);
    if (!rule || typeof rule.id !== "string" || !ID_RE.test(rule.id) || ids.has(rule.id)) throw new V12ValidationError("Identifiant de règle NBA invalide ou dupliqué.");
    ids.add(rule.id);
    boundedInteger(rule.version ?? 1, 1, 100000, "Version de règle NBA invalide.");
    boundedInteger(rule.priority ?? 50, 1, 100, "Priorité NBA invalide.");
    if (rule.active !== undefined && typeof rule.active !== "boolean") throw new V12ValidationError("État NBA invalide.");
    if (typeof rule.action !== "string" || !rule.action.trim() || rule.action.length > 120) throw new V12ValidationError("Action NBA invalide.");
    if (typeof rule.reason !== "string" || !rule.reason.trim() || rule.reason.length > 240) throw new V12ValidationError("Justification NBA invalide.");
    if (rule.dueInDays !== undefined) boundedInteger(rule.dueInDays, 0, 365, "Échéance NBA invalide.");
    validateConditions(rule.conditions);
  }
}

function validateConditions(value: unknown) {
  const conditions = Array.isArray(value) ? value : [];
  if (conditions.length > 25) throw new V12ValidationError("Trop de conditions.");
  for (const raw of conditions) {
    const condition = asObject(raw);
    if (!condition || typeof condition.field !== "string" || !FIELD_RE.test(condition.field)) throw new V12ValidationError("Champ de condition invalide.");
    if (!OPERATORS.has(String(condition.operator))) throw new V12ValidationError("Opérateur de condition invalide.");
    if (condition.operator !== "exists" && condition.value === undefined) throw new V12ValidationError("Valeur de condition manquante.");
  }
}

function normalizeKind(value: string): V12ConfigKind {
  if ((V12_CONFIG_KINDS as readonly string[]).includes(value)) return value as V12ConfigKind;
  throw new V12ValidationError("Type de configuration v1.2 invalide.");
}

function normalizeName(value: string) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 120) throw new V12ValidationError("Nom de configuration invalide.");
  return name;
}

function decodeConfiguration(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    name: String(row.name),
    version: Number(row.version),
    active: Number(row.active) === 1,
    definition: asObject(parseJson(row.definition)) ?? {},
    createdAt: row.created_at ? new Date(row.created_at as string | Date).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at as string | Date).toISOString() : undefined,
  };
}

function boundedInteger(value: unknown, min: number, max: number, message: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new V12ValidationError(message);
  return number;
}
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return null; } }
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
