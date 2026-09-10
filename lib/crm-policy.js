export const CORE_RECORD_TYPES = Object.freeze([
  "company",
  "contact",
  "lead",
  "opportunity",
  "task",
  "appointment",
  "note",
  "document",
  "product",
  "service",
  "quote",
  "invoice",
  "contract",
]);

export const CONFIG_KINDS = Object.freeze([
  "object",
  "pipeline",
  "form",
  "automation",
  "module",
  "template",
  "webhook",
]);

const CORE_TYPE_SET = new Set(CORE_RECORD_TYPES);
const CONFIG_KIND_SET = new Set(CONFIG_KINDS);
const RECORD_STATUS_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const KEY_RE = /^[a-z][a-z0-9_-]{0,49}$/;
const EVENT_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;
const FIELD_TYPES = new Set([
  "text",
  "number",
  "date",
  "datetime",
  "boolean",
  "email",
  "phone",
  "currency",
  "select",
  "relation",
  "textarea",
]);
const AUTOMATION_EVENTS = new Set([
  "record.created",
  "record.updated",
  "record.archived",
]);
const AUTOMATION_OPERATORS = new Set([
  "eq",
  "neq",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
]);
const AUTOMATION_ACTIONS = new Set([
  "create_task",
  "set_status",
  "timeline",
]);

export function normalizeRecordType(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return KEY_RE.test(normalized) ? normalized : null;
}

export function isCoreRecordType(value) {
  return CORE_TYPE_SET.has(value);
}

export function normalizeRecordStatus(value, fallback = "active") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return RECORD_STATUS_RE.test(normalized) ? normalized : null;
}

export function validateRecordInput(input, options = {}) {
  if (!isPlainObject(input)) return fail("Payload invalide.");

  const type = normalizeRecordType(input.type ?? options.type);
  if (!type) return fail("Type CRM invalide.");

  const title = normalizeText(input.title, 160);
  if (!title) return fail("Titre requis.");

  const status = normalizeRecordStatus(input.status, options.status ?? "active");
  if (!status) return fail("Statut invalide.");

  const dataInput = input.data === undefined ? {} : input.data;
  if (!isPlainObject(dataInput)) return fail("Les données métier doivent être un objet JSON.");

  let data;
  try {
    data = normalizeTypeData(type, structuredClone(dataInput));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Données métier invalides.");
  }

  const serialized = JSON.stringify(data);
  if (serialized.length > 131072) return fail("Données métier trop volumineuses.");

  return {
    ok: true,
    value: { type, title, status, data },
  };
}

export function calculateCommercialDocument(data) {
  if (!isPlainObject(data)) throw new Error("Document commercial invalide.");
  const currency = normalizeCurrency(data.currency ?? "EUR");
  if (!currency) throw new Error("Devise invalide.");
  if (!Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > 200) {
    throw new Error("Le document doit contenir entre 1 et 200 lignes.");
  }

  let subtotalCents = 0;
  let taxCents = 0;
  const lines = data.lines.map((rawLine, index) => {
    if (!isPlainObject(rawLine)) throw new Error(`Ligne ${index + 1} invalide.`);
    const description = normalizeText(rawLine.description, 240);
    const quantity = Number(rawLine.quantity);
    const unitPriceCents = Number(rawLine.unitPriceCents);
    const taxRateBasisPoints = rawLine.taxRateBasisPoints === undefined
      ? 0
      : Number(rawLine.taxRateBasisPoints);

    if (!description) throw new Error(`Description requise à la ligne ${index + 1}.`);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      throw new Error(`Quantité invalide à la ligne ${index + 1}.`);
    }
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 10_000_000_000) {
      throw new Error(`Prix unitaire invalide à la ligne ${index + 1}.`);
    }
    if (!Number.isInteger(taxRateBasisPoints) || taxRateBasisPoints < 0 || taxRateBasisPoints > 10000) {
      throw new Error(`Taux de taxe invalide à la ligne ${index + 1}.`);
    }

    const lineSubtotalCents = Math.round(quantity * unitPriceCents);
    const lineTaxCents = Math.round((lineSubtotalCents * taxRateBasisPoints) / 10000);
    const lineTotalCents = lineSubtotalCents + lineTaxCents;
    subtotalCents += lineSubtotalCents;
    taxCents += lineTaxCents;

    return {
      description,
      quantity,
      unitPriceCents,
      taxRateBasisPoints,
      subtotalCents: lineSubtotalCents,
      taxCents: lineTaxCents,
      totalCents: lineTotalCents,
    };
  });

  return {
    ...data,
    currency,
    lines,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

export function extractKnownRecordRefs(data) {
  if (!isPlainObject(data)) return [];
  const keys = [
    "companyId",
    "contactId",
    "leadId",
    "opportunityId",
    "quoteId",
    "invoiceId",
    "contractId",
    "productId",
    "serviceId",
    "parentId",
  ];
  return [...new Set(keys.map((key) => data[key]).filter((value) => typeof value === "string" && value.length > 0))];
}

export function validateConfiguration(kind, definition) {
  if (!CONFIG_KIND_SET.has(kind)) return fail("Type de configuration invalide.");
  if (!isPlainObject(definition)) return fail("Définition de configuration invalide.");

  try {
    if (kind === "object") validateObjectDefinition(definition);
    if (kind === "pipeline") validatePipelineDefinition(definition);
    if (kind === "form") validateFormDefinition(definition);
    if (kind === "automation") validateAutomationDefinition(definition);
    if (kind === "module") validateModuleDefinition(definition);
    if (kind === "template") validateTemplateDefinition(definition);
    if (kind === "webhook") validateWebhookDefinition(definition);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Configuration invalide.");
  }

  const serialized = JSON.stringify(definition);
  if (serialized.length > 131072) return fail("Configuration trop volumineuse.");
  return { ok: true, value: structuredClone(definition) };
}

export function evaluateAutomationConditions(conditions, record) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  if (!record || !isPlainObject(record)) return false;
  const data = isPlainObject(record.data) ? record.data : {};

  return conditions.every((condition) => {
    if (!isPlainObject(condition)) return false;
    const field = typeof condition.field === "string" ? condition.field : "";
    const operator = condition.operator;
    if (!field || !AUTOMATION_OPERATORS.has(operator)) return false;
    const actual = field === "title" || field === "status" || field === "type"
      ? record[field]
      : data[field];
    const expected = condition.value;

    if (operator === "exists") return actual !== undefined && actual !== null && actual !== "";
    if (operator === "eq") return actual === expected;
    if (operator === "neq") return actual !== expected;
    if (operator === "contains") return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (operator === "gt") return left > right;
    if (operator === "gte") return left >= right;
    if (operator === "lt") return left < right;
    if (operator === "lte") return left <= right;
    return false;
  });
}

export function renderAutomationTemplate(value, record) {
  if (typeof value !== "string") return "";
  return value
    .replaceAll("{{id}}", String(record?.id ?? ""))
    .replaceAll("{{title}}", String(record?.title ?? ""))
    .replaceAll("{{type}}", String(record?.type ?? ""))
    .slice(0, 240);
}

export function normalizeWebhookUrl(value, options = {}) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (options.allowPrivate) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return null;
  if (isPrivateIpv4(host)) return null;
  return url.toString();
}

export function isValidConfigKind(value) {
  return CONFIG_KIND_SET.has(value);
}

function normalizeTypeData(type, data) {
  if (type === "contact" && data.email !== undefined) {
    if (typeof data.email !== "string" || data.email.length > 254 || !data.email.includes("@")) {
      throw new Error("Adresse e-mail du contact invalide.");
    }
    data.email = data.email.trim().toLowerCase();
  }

  if (type === "opportunity") {
    if (data.amountCents !== undefined && (!Number.isInteger(data.amountCents) || data.amountCents < 0)) {
      throw new Error("Montant d'opportunité invalide.");
    }
    if (data.probability !== undefined) {
      const probability = Number(data.probability);
      if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
        throw new Error("Probabilité d'opportunité invalide.");
      }
    }
    if (data.stage !== undefined && !normalizeRecordStatus(data.stage, null)) {
      throw new Error("Étape d'opportunité invalide.");
    }
  }

  if (type === "task") {
    if (data.completed !== undefined && typeof data.completed !== "boolean") {
      throw new Error("État de tâche invalide.");
    }
    validateOptionalIsoDateTime(data.dueAt, "Échéance de tâche invalide.");
  }

  if (type === "appointment") {
    validateOptionalIsoDateTime(data.startsAt, "Début de rendez-vous invalide.", true);
    validateOptionalIsoDateTime(data.endsAt, "Fin de rendez-vous invalide.", true);
    if (new Date(data.endsAt).getTime() <= new Date(data.startsAt).getTime()) {
      throw new Error("La fin du rendez-vous doit être postérieure au début.");
    }
  }

  if (type === "note") {
    const body = normalizeText(data.body, 20000);
    if (!body) throw new Error("Contenu de note requis.");
    data.body = body;
  }

  if (type === "document") {
    if (data.fileName !== undefined && !normalizeText(data.fileName, 255)) {
      throw new Error("Nom de document invalide.");
    }
    if (data.mimeType !== undefined && !normalizeText(data.mimeType, 120)) {
      throw new Error("Type MIME invalide.");
    }
    if (data.url !== undefined && (typeof data.url !== "string" || data.url.length > 2048)) {
      throw new Error("URL de document invalide.");
    }
  }

  if (type === "product" || type === "service") {
    if (data.unitPriceCents !== undefined && (!Number.isInteger(data.unitPriceCents) || data.unitPriceCents < 0)) {
      throw new Error("Prix unitaire invalide.");
    }
    if (data.currency !== undefined) {
      const currency = normalizeCurrency(data.currency);
      if (!currency) throw new Error("Devise invalide.");
      data.currency = currency;
    }
  }

  if (type === "quote" || type === "invoice") {
    data = calculateCommercialDocument(data);
    validateOptionalIsoDate(data.issueDate, "Date d'émission invalide.");
    validateOptionalIsoDate(data.dueDate, "Date d'échéance invalide.");
  }

  if (type === "contract") {
    validateOptionalIsoDate(data.startDate, "Date de début de contrat invalide.");
    validateOptionalIsoDate(data.endDate, "Date de fin de contrat invalide.");
    if (data.startDate && data.endDate && data.endDate < data.startDate) {
      throw new Error("La fin du contrat doit être postérieure au début.");
    }
  }

  return data;
}

function validateObjectDefinition(definition) {
  const key = normalizeRecordType(definition.key);
  if (!key) throw new Error("Clé d'objet invalide.");
  if (!normalizeText(definition.label, 100)) throw new Error("Libellé d'objet requis.");
  if (!Array.isArray(definition.fields) || definition.fields.length > 100) {
    throw new Error("Liste de champs invalide.");
  }
  const seen = new Set();
  for (const field of definition.fields) {
    if (!isPlainObject(field) || typeof field.key !== "string" || !KEY_RE.test(field.key)) {
      throw new Error("Clé de champ invalide.");
    }
    if (seen.has(field.key)) throw new Error("Clé de champ dupliquée.");
    seen.add(field.key);
    if (!FIELD_TYPES.has(field.type)) throw new Error(`Type de champ invalide: ${field.type ?? ""}.`);
    if (!normalizeText(field.label, 100)) throw new Error("Libellé de champ requis.");
    if (field.type === "select" && (!Array.isArray(field.options) || field.options.length > 100)) {
      throw new Error("Options de champ select invalides.");
    }
  }
}

function validatePipelineDefinition(definition) {
  if (!KEY_RE.test(String(definition.key ?? ""))) throw new Error("Clé de pipeline invalide.");
  const objectType = normalizeRecordType(definition.objectType);
  if (!objectType) throw new Error("Type d'objet du pipeline invalide.");
  if (!Array.isArray(definition.stages) || definition.stages.length < 2 || definition.stages.length > 30) {
    throw new Error("Un pipeline doit contenir entre 2 et 30 étapes.");
  }
  const seen = new Set();
  for (const stage of definition.stages) {
    if (!isPlainObject(stage) || !KEY_RE.test(String(stage.key ?? "")) || !normalizeText(stage.label, 100)) {
      throw new Error("Étape de pipeline invalide.");
    }
    if (seen.has(stage.key)) throw new Error("Étape de pipeline dupliquée.");
    seen.add(stage.key);
  }
}

function validateFormDefinition(definition) {
  if (!KEY_RE.test(String(definition.key ?? ""))) throw new Error("Clé de formulaire invalide.");
  if (!normalizeRecordType(definition.objectType)) throw new Error("Type d'objet du formulaire invalide.");
  if (!Array.isArray(definition.fields) || definition.fields.length < 1 || definition.fields.length > 100) {
    throw new Error("Champs de formulaire invalides.");
  }
  const seen = new Set();
  for (const field of definition.fields) {
    if (!isPlainObject(field) || !KEY_RE.test(String(field.key ?? ""))) throw new Error("Champ de formulaire invalide.");
    if (seen.has(field.key)) throw new Error("Champ de formulaire dupliqué.");
    seen.add(field.key);
  }
}

function validateAutomationDefinition(definition) {
  if (!KEY_RE.test(String(definition.key ?? ""))) throw new Error("Clé d'automatisation invalide.");
  if (!isPlainObject(definition.trigger) || !AUTOMATION_EVENTS.has(definition.trigger.event)) {
    throw new Error("Déclencheur d'automatisation invalide.");
  }
  if (definition.trigger.type !== undefined && !normalizeRecordType(definition.trigger.type)) {
    throw new Error("Type de déclencheur invalide.");
  }
  if (definition.conditions !== undefined) {
    if (!Array.isArray(definition.conditions) || definition.conditions.length > 20) {
      throw new Error("Conditions d'automatisation invalides.");
    }
    for (const condition of definition.conditions) {
      if (!isPlainObject(condition) || !KEY_RE.test(String(condition.field ?? "")) || !AUTOMATION_OPERATORS.has(condition.operator)) {
        throw new Error("Condition d'automatisation invalide.");
      }
    }
  }
  if (!Array.isArray(definition.actions) || definition.actions.length < 1 || definition.actions.length > 10) {
    throw new Error("Actions d'automatisation invalides.");
  }
  for (const action of definition.actions) {
    if (!isPlainObject(action) || !AUTOMATION_ACTIONS.has(action.kind)) {
      throw new Error("Action d'automatisation invalide.");
    }
    if (action.kind === "set_status" && !normalizeRecordStatus(action.status, null)) {
      throw new Error("Statut d'automatisation invalide.");
    }
    if (action.kind === "create_task" && !normalizeText(action.title, 240)) {
      throw new Error("Titre de tâche d'automatisation requis.");
    }
    if (action.kind === "timeline" && !normalizeText(action.summary, 240)) {
      throw new Error("Résumé de timeline requis.");
    }
  }
}

function validateModuleDefinition(definition) {
  if (!KEY_RE.test(String(definition.key ?? ""))) throw new Error("Clé de module invalide.");
  if (definition.dependsOn !== undefined) {
    if (!Array.isArray(definition.dependsOn) || definition.dependsOn.length > 20) throw new Error("Dépendances de module invalides.");
    for (const dependency of definition.dependsOn) {
      if (!KEY_RE.test(String(dependency))) throw new Error("Dépendance de module invalide.");
      if (dependency === definition.key) throw new Error("Un module ne peut pas dépendre de lui-même.");
    }
  }
}

function validateTemplateDefinition(definition) {
  if (!KEY_RE.test(String(definition.key ?? ""))) throw new Error("Clé de template invalide.");
  if (!Array.isArray(definition.configs) || definition.configs.length < 1 || definition.configs.length > 50) {
    throw new Error("Contenu de template invalide.");
  }
  for (const entry of definition.configs) {
    if (!isPlainObject(entry) || !CONFIG_KIND_SET.has(entry.kind) || entry.kind === "template" || entry.kind === "webhook") {
      throw new Error("Entrée de template invalide.");
    }
    if (!normalizeText(entry.name, 120) || !isPlainObject(entry.definition)) throw new Error("Configuration de template invalide.");
    const nested = validateConfiguration(entry.kind, entry.definition);
    if (!nested.ok) throw new Error(nested.error);
  }
}

function validateWebhookDefinition(definition) {
  if (!KEY_RE.test(String(definition.key ?? ""))) throw new Error("Clé de webhook invalide.");
  if (definition.direction !== "inbound" && definition.direction !== "outbound") throw new Error("Direction de webhook invalide.");
  if (!EVENT_RE.test(String(definition.event ?? ""))) throw new Error("Événement webhook invalide.");
  if (definition.direction === "outbound" && typeof definition.url !== "string") throw new Error("URL webhook sortant requise.");
  if (definition.direction === "inbound") {
    if (definition.createType !== undefined && !normalizeRecordType(definition.createType)) throw new Error("Type créé par webhook invalide.");
    if (definition.titleField !== undefined && !KEY_RE.test(String(definition.titleField))) throw new Error("Champ titre webhook invalide.");
  }
}

function normalizeCurrency(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function validateOptionalIsoDate(value, message) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(message);
  }
}

function validateOptionalIsoDateTime(value, message, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(message);
    return;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeText(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function isPrivateIpv4(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function fail(error) {
  return { ok: false, error };
}
