import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations, crmRecords } from "@/db/schema";
import { isCoreRecordType } from "@/lib/crm-policy.js";

export class CrmConfigurationValidationError extends Error {
  status = 400;
}

export async function validateConfiguredRecordData(
  tenantId: string,
  type: string,
  data: Record<string, unknown>,
) {
  let objectDefinition: Record<string, unknown> | null = null;
  if (!isCoreRecordType(type)) {
    objectDefinition = await findConfigurationByKey(tenantId, "object", type);
    if (!objectDefinition) {
      throw new CrmConfigurationValidationError("Objet métier personnalisé inconnu ou désactivé.");
    }
    await validateCustomFields(tenantId, objectDefinition, data);
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
  }

  return { objectDefinition };
}

async function validateCustomFields(
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
    if (fieldType === "date" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit contenir une date valide.`);
    }
    if (fieldType === "datetime" && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
      throw new CrmConfigurationValidationError(`Le champ ${key} doit contenir une date/heure valide.`);
    }
    if (fieldType === "select" && Array.isArray(field.options)) {
      const options = field.options.map(String);
      if (!options.includes(String(value))) {
        throw new CrmConfigurationValidationError(`Valeur hors options pour le champ ${key}.`);
      }
    }
    if (fieldType === "relation") relationIds.push(String(value));
  }

  if (relationIds.length > 0) {
    const uniqueIds = [...new Set(relationIds)];
    const db = getDb();
    const rows = await db
      .select({ id: crmRecords.id, tenantId: crmRecords.tenantId })
      .from(crmRecords)
      .where(inArray(crmRecords.id, uniqueIds));
    if (rows.length !== uniqueIds.length || rows.some((row) => row.tenantId !== tenantId)) {
      throw new CrmConfigurationValidationError("Une relation personnalisée cible un autre tenant ou une ressource absente.");
    }
  }
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
      ),
    )
    .limit(300);

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.definition) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const definition = parsed as Record<string, unknown>;
        if (definition.key === key) return definition;
      }
    } catch {
      // Une configuration illisible n'est jamais considérée comme active et valide.
    }
  }
  return null;
}
