import { filterProcedures } from "./resolver.js";
import { helpCatalog } from "./catalog.js";

function haystack(procedure) {
  return [
    procedure.id,
    procedure.title,
    procedure.description,
    procedure.tags.join(" "),
    procedure.contexts.join(" "),
    procedure.recordTypes?.join(" ") ?? "",
    procedure.steps.map((step) => `${step.title} ${step.instruction} ${step.expected ?? ""}`).join(" "),
  ].join(" ").toLowerCase();
}

export function searchHelp(query, context = {}, catalog = helpCatalog) {
  const q = String(query ?? "").trim().toLowerCase();
  const visible = filterProcedures(context, catalog);
  if (!q) return visible;
  const tokens = q.split(/\s+/).filter(Boolean);
  return visible
    .map((procedure) => {
      const text = haystack(procedure);
      const score = tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
      const idBoost = procedure.id.toLowerCase().includes(q) ? 5 : 0;
      const titleBoost = procedure.title.toLowerCase().includes(q) ? 3 : 0;
      return { procedure, score: score + idBoost + titleBoost };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.procedure.id.localeCompare(b.procedure.id))
    .map((item) => item.procedure);
}