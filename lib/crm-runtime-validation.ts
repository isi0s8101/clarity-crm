import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations, crmRecords } from "@/db/schema";
import { isCoreRecordType, isSafeConfiguredPattern } from "@/lib/crm-policy.js";

export class CrmConfigurationValidationError extends Error {
  status = 400;
}

export type ConfiguredRelationDefinition = {
  key: string;
  sourceType: string;
  targetType: string;
  cardinality: "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
};

export async function getConfiguredRelationDefinition(tenantId: string, key: string) {
  const db = getDb();
  const rows = await db
    .select({ active: crmConfigurations.active, definition: crmConfigurations.definition })
    .from(crmConfigurations)
    .where(and(
      eq(crmConfigurations.tenantId, tenantId),
      eq(crmConfigurations.kind, "relation"),
      eq(crmConfigurations.configKey, key),
    ))
    .limit(1);

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.definition) as Partial<ConfiguredRelationDefinition>;
      if (parsed.key !== key) continue;
      if (row.active !== 1) {
        throw new CrmConfigurationValidationError("Type de relation configuré mais désactivé.");
      }
      if (
        typeof parsed.sourceType !== "string" ||
        typeof parsed.targetType !== "string" ||
        !["one_to_one", "one_to_many", "many_to_one", "many_to_many"].includes(String(parsed.cardinality))
      ) {
        throw new CrmConfigurationValidationError("Configuration de relation invalide.");
      }
      return parsed as ConfiguredRelationDefinition;
    } catch (error) {
      if (error instanceof CrmConfigurationValidationError) throw error;
      throw new CrmConfigurationValidationError("Configuration de relation illisible.");
    }
  }
  return null;
}

export async function validateConfiguredRecordData(
  tenantId: string,
  type: string,
  data: Record<string, unknown>,
  previousData?: Record<string, unknown>,
) {
  let objectDefinition: Record<string, unknown> | null = null;
  if (!isCoreRecordType(type)) {
    objectDefinition = await findConfigurationByKey(tenantId, "object", type);
    if (!objectDefinition) {
      throw new CrmConfigurationValidationError("Objet métier personnalisé inconnu ou désactivé.");
    }
    await validateCustomFieldValues(tenantId, objectDefinition, data);
  }

  const pipelineKey = typeof data.pipelineKey === "string" ? data.pipelineKey : null;
  const stage = typeof data.stage === "string" ? data.stage : null;
  if ((pipelineKey && !stage) || (!pipelineKey && stage && !isCoreRecordType(type))) {
    throw new CrmConfigurationValidationError("Pipeline et étape doivent être cohérents.");
  }
  if (pipelineKey) {
    const pipeline = await findConfigurationByKey(tenantId, "pipeline", pipelineKey);
    if (!pipeline || pipeline.objectType !== type || !Array.isArray(pipeline.stages)) {
      throw new CrmConfigurationValidationError("Pipeline inconnu ou incompatible avec l'objet.");
    }
    const allowedStages = new Set(
      pipeline.stages
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        .map((entry) => entry.key)
        .filter((key): key is string => typeof key === "string"),
    );
    if (!stage || !allowedStages.has(stage)) {
      throw new CrmConfigurationValidationError("Étape absente du pipeline configuré.");
    }
    const previousStage = previousData?.pipelineKey === pipelineKey && typeof previousData.stage === "string"
      ? previousData.stage
      : null;
    if (previousStage && previousStage !== stage && Array.isArray(pipeline.transitions)) {
      const allowed = pipeline.transitions.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const transition = entry as Record<string, unknown>;
        return transition.from === previousStage && transition.to === stage;
      });
      if (!allowed) throw new CrmConfigurationValidationError("Transition de pipeline interdite.");
    }
  }

  return { objectDefinition };
}

export async function validateCustomFieldValues(
  tenantId: string,
  definition: Record<string, unknown>,
  data: Record<string, unknown>,
) {
  const fields = Array.isArray(definition.fields) ? definition.fields : [];
  const relationIds: string[] = [];

  for (const rawField of fields) {
    if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) continue;
    const field = rawField as Record<string, unknown>;
    const key = typeof field.key === "string" ? field.key : "";
    if (!key) continue;
    const value = data[key];
    const missing = value === undefined || value === null || value === "";
    if (field.required === true && missing) {
      throw new CrmConfigurationValidationError(`Champ obligatoire manquant : ${key}.`);
    }
    if (missing) continue;

    const fieldType = field.type;
    if (["text", "textarea", "email", "phone", "select", "date", "datetime", "relation"].includes(String(fieldType)) && typeof value !== "string") {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit être une chaîne.`);
    }
    if ((fieldType === "number" || fieldType === "currency") && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit être numérique.`);
    }
    if (fieldType === "boolean" && typeof value !== "boolean") {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit être booléen.`);
    }
    if (fieldType === "email" && (typeof value !== "string" || value.length > 254 || !value.includes("@"))) {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit contenir un e-mail valide.`);
    }
    if (fieldType === "date" && (typeof value !== "string" || !isValidIsoDate(value))) {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit contenir une date valide.`);
    }
    if (fieldType === "datetime" && (typeof value !== "string" || !isValidIsoDateTime(value))) {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit contenir une date/heure valide.`);
    }
    if (fieldType === "select" && Array.isArray(field.options)) {
      const options = field.options.map(String);
      if (!options.includes(String(value))) {
        throw new CrmConfigurationValidationError(`Valeur hors options pour le champ ${key}.`);
      }
    }
    if (typeof value === "string") {
      if (typeof field.minLength === "number" && value.length < field.minLength) {
        throw new CrmConfigurationValidationError(`Le champ ${key} est trop court.`);
      }
      if (typeof field.maxLength === "number" && value.length > field.maxLength) {
        throw new CrmConfigurationValidationError(`Le champ ${key} est trop long.`);
      }
      if (typeof field.pattern === "string") {
        if (!isSafeConfiguredPattern(field.pattern)) {
          throw new CrmConfigurationValidationError(`Le format configuré pour le champ ${key} n'est pas sûr.`);
        }
        if (!new RegExp(field.pattern, "u").test(value)) {
          throw new CrmConfigurationValidationError(`Le champ ${key} ne respecte pas le format requis.`);
        }
      }
    }
    if (typeof value === "number") {
      if (typeof field.min === "number" && value < field.min) {
        throw new CrmConfigurationValidationError(`Le champ ${key} est inférieur au minimum.`);
      }
      if (typeof field.max === "number" && value > field.max) {
        throw new CrmConfigurationValidationError(`Le champ ${key} dépasse le maximum.`);
      }
    }
    if (fieldType === "relation") relationIds.push(String(value));
  }

  if (relationIds.length > 0) {
    const uniqueIds = [...new Set(relationIds)];
    const db = getDb();
    const rows = await db
      .select({ id: crmRecords.id, tenantId: crmRecords.tenantId, type: crmRecords.type })
      .from(crmRecords)
      .where(inArray(crmRecords.id, uniqueIds));
    if (rows.length !== uniqueIds.length || rows.some((row) => row.tenantId !== tenantId)) {
      throw new CrmConfigurationValidationError("Une relation personnalisée cible un autre tenant ou une ressource absente.");
    }
    for (const rawField of fields) {
      if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) continue;
      const field = rawField as Record<string, unknown>;
      if (field.type !== "relation" || typeof field.key !== "string" || typeof field.targetType !== "string") continue;
      const value = data[field.key];
      if (typeof value !== "string") continue;
      const target = rows.find((row) => row.id === value);
      if (!target) continue;
      if (target.type !== field.targetType) {
        throw new CrmConfigurationValidationError(`Le champ ${field.key} cible un type d'objet incompatible.`);
      }
    }
  }
}

function isValidIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidIsoDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

async function findConfigurationByKey(tenantId: string, kind: string, key: string) {
  const db = getDb();
  const rows = await db
    .select({ definition: crmConfigurations.definition })
    .from(crmConfigurations)
    .where(
      and(
        eq(crmConfigurations.tenantId, tenantId),
        eq(crmConfigurations.kind, kind),
        eq(crmConfigurations.active, 1),
        eq(crmConfigurations.configKey, key),
      ),
    )
    .limit(1);

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.definition) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const definition = parsed as Record<string, unknown>;
        if (typeof definition.key === "string" && definition.key.trim().toLowerCase() === key) return definition;
      }
    } catch {
      // Une configuration illisible n'est jamais considérée comme active et valide.
    }
  }
  return null;
}
