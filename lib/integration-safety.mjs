const SENSITIVE_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|bind[_-]?password|authorization|credential|credentials|cookie|api[_-]?key|private[_-]?key)$/i;
const MAX_DEPTH = 16;
const MAX_NODES = 10000;

export function assertNoSensitiveIntegrationKeys(value, label = "Configuration") {
  let nodes = 0;
  walk(value, [], 0, (key, path) => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error(`${label} trop complexe.`);
    if (SENSITIVE_KEY.test(normalizeKey(key))) {
      throw new Error(`${label} contient une clé sensible interdite: ${formatPath(path)}.`);
    }
  });
  return value;
}

export function sanitizeIntegrationDetails(value) {
  let nodes = 0;
  return clone(value, 0);

  function clone(item, depth) {
    if (depth > MAX_DEPTH) return "[TRUNCATED]";
    nodes += 1;
    if (nodes > MAX_NODES) return "[TRUNCATED]";
    if (item === null || item === undefined || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item === "string") return item.slice(0, 2000);
    if (Array.isArray(item)) return item.slice(0, 200).map((entry) => clone(entry, depth + 1));
    if (typeof item !== "object") return String(item).slice(0, 2000);
    const output = {};
    for (const [key, entry] of Object.entries(item).slice(0, 200)) {
      output[key] = SENSITIVE_KEY.test(normalizeKey(key)) ? "[REDACTED]" : clone(entry, depth + 1);
    }
    return output;
  }
}

export function isSensitiveIntegrationKey(key) {
  return SENSITIVE_KEY.test(normalizeKey(key));
}

function walk(value, path, depth, visitor) {
  if (depth > MAX_DEPTH) throw new Error("Configuration d'intégration trop profonde.");
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, [...path, `[${index}]`], depth + 1, visitor));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...path, key];
    visitor(key, nextPath);
    walk(entry, nextPath, depth + 1, visitor);
  }
}
function normalizeKey(value) { return String(value).replace(/\s+/g, "").toLowerCase(); }
function formatPath(path) { return path.join(".").replace(/\.\[/g, "[") || "(racine)"; }
