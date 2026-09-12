const TEXT_OPERATORS = new Set(["eq", "ne", "contains", "not_contains", "starts_with", "exists", "not_exists"]);
const DATE_OPERATORS = new Set(["eq", "ne", "before", "after", "gte", "lte", "between", "exists", "not_exists"]);
const DATA_OPERATORS = new Set(["eq", "ne", "contains", "not_contains", "starts_with", "exists", "not_exists", "gt", "lt", "gte", "lte", "between"]);

export class CrmFilterValidationError extends Error {
  status = 400;
}

/**
 * Parses a compact, bounded filter tree. Field names are deliberately data,
 * never SQL identifiers: SQL generation maps every accepted name itself.
 */
export function parseCrmFilters(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmFilterValidationError("Filtres CRM invalides.");
  const logic = value.logic === "or" ? "or" : value.logic === "and" || value.logic === undefined ? "and" : null;
  const rules = value.rules;
  if (!logic || !Array.isArray(rules) || rules.length === 0 || rules.length > 20) throw new CrmFilterValidationError("Filtres CRM invalides.");
  return { logic, rules: rules.map(parseRule) };
}

function parseRule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmFilterValidationError("Règle de filtre invalide.");
  const field = typeof value.field === "string" ? value.field : "";
  const operator = typeof value.operator === "string" ? value.operator : "";
  const fieldKind = field === "title" || field === "status" ? "text" : field === "createdAt" || field === "updatedAt" ? "date" : /^data\.[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) ? "data" : "";
  const allowed = fieldKind === "text" ? TEXT_OPERATORS : fieldKind === "date" ? DATE_OPERATORS : fieldKind === "data" ? DATA_OPERATORS : null;
  if (!allowed?.has(operator)) throw new CrmFilterValidationError("Champ ou opérateur de filtre interdit.");
  const needsValue = operator !== "exists" && operator !== "not_exists";
  const valueItem = value.value;
  if (needsValue && !isValidValue(valueItem, operator, fieldKind)) throw new CrmFilterValidationError("Valeur de filtre invalide.");
  if (!needsValue && valueItem !== undefined) throw new CrmFilterValidationError("Valeur de filtre inattendue.");
  return needsValue ? { field, operator, value: valueItem } : { field, operator };
}

function isValidValue(value, operator, fieldKind) {
  if (operator === "between") {
    return Array.isArray(value) && value.length === 2 && value.every((item) => isScalar(item, fieldKind));
  }
  return isScalar(value, fieldKind);
}

function isScalar(value, fieldKind) {
  if (fieldKind === "date") return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
  if (fieldKind === "text") return typeof value === "string" && value.length <= 160;
  return (typeof value === "string" && value.length <= 160) || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean";
}
