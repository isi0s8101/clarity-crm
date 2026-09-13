import { getPool } from "@/db";
import { type AuthContext } from "@/lib/authz";
import { getCrmRecord, listCrmRecords } from "@/lib/crm-core";
import { V12ValidationError } from "@/lib/v12-planning";

const SUPPORTED_TYPES = new Set(["contact", "company", "lead", "opportunity"]);

type Criterion = {
  id: string;
  kind: "email" | "phone" | "company_name" | "name_address" | "name_email" | "business_id";
  field?: string;
  weight: number;
  reason: string;
};

export async function detectDuplicates(actor: AuthContext, recordId: string) {
  const source = await getCrmRecord(actor, recordId, "read");
  if (!SUPPORTED_TYPES.has(source.type)) throw new V12ValidationError("Type non pris en charge par la détection de doublons.");
  const criteria = await loadCriteria(actor.tenantId, source.type);
  if (!criteria.length) return { source, candidates: [], ruleConfigured: false };
  const records = await listCrmRecords(actor, { type: source.type, limit: 100 });
  const candidates = [];
  for (const candidate of records) {
    if (candidate.id === source.id || candidate.status === "archived") continue;
    const reasons: Array<{ criterionId: string; kind: string; reason: string; compared: string }> = [];
    let totalWeight = 0;
    let matchedWeight = 0;
    for (const criterion of criteria) {
      totalWeight += criterion.weight;
      const compared = compareCriterion(criterion, source, candidate);
      if (!compared) continue;
      matchedWeight += criterion.weight;
      reasons.push({ criterionId: criterion.id, kind: criterion.kind, reason: criterion.reason, compared });
    }
    if (!reasons.length || totalWeight <= 0) continue;
    const confidence = Math.round((matchedWeight / totalWeight) * 100);
    const strong = reasons.some((reason) => ["email", "phone", "business_id"].includes(reason.kind));
    if (confidence < 30 && !strong) continue;
    candidates.push({
      recordId: candidate.id,
      title: candidate.title,
      type: candidate.type,
      classification: strong && confidence >= 50 ? "exact" : "probable",
      confidence,
      reasons,
    });
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.title.localeCompare(b.title));
  return { source, candidates, ruleConfigured: true };
}

async function loadCriteria(tenantId: string, type: string): Promise<Criterion[]> {
  const result = await getPool().query(
    `SELECT definition FROM crm_configurations
     WHERE tenant_id=$1 AND kind='duplicate_rule' AND active=1
     ORDER BY version DESC,updated_at DESC LIMIT 100`,
    [tenantId],
  );
  for (const row of result.rows) {
    const definition = asObject(parseJson(row.definition));
    if (definition?.targetType !== type || !Array.isArray(definition.criteria)) continue;
    return definition.criteria.map(asObject).filter(Boolean).map((item) => ({
      id: String(item?.id ?? "criterion"),
      kind: String(item?.kind ?? "email") as Criterion["kind"],
      field: typeof item?.field === "string" ? item.field : undefined,
      weight: clampWeight(item?.weight),
      reason: typeof item?.reason === "string" ? item.reason : "Critère déterministe concordant.",
    }));
  }
  if (type === "contact" || type === "lead") return [
    { id: "email_exact", kind: "email", weight: 60, reason: "Adresse e-mail normalisée identique." },
    { id: "phone_exact", kind: "phone", weight: 40, reason: "Numéro de téléphone normalisé identique." },
    { id: "name_email", kind: "name_email", weight: 50, reason: "Nom et adresse e-mail concordent." },
  ];
  if (type === "company") return [
    { id: "company_name", kind: "company_name", weight: 60, reason: "Raison sociale normalisée identique." },
    { id: "name_address", kind: "name_address", weight: 40, reason: "Nom et adresse normalisés concordent." },
  ];
  return [];
}

function compareCriterion(criterion: Criterion, left: { title: string; data: Record<string, unknown> }, right: { title: string; data: Record<string, unknown> }) {
  if (criterion.kind === "email") {
    const a = normalizeEmail(left.data.email); const b = normalizeEmail(right.data.email);
    return equal(a, b) ? maskEmail(a) : "";
  }
  if (criterion.kind === "phone") {
    const a = normalizePhone(left.data.phone ?? left.data.mobile); const b = normalizePhone(right.data.phone ?? right.data.mobile);
    return equal(a, b) ? maskPhone(a) : "";
  }
  if (criterion.kind === "company_name") {
    return equal(normalizeName(left.data.companyName ?? left.title), normalizeName(right.data.companyName ?? right.title)) ? "raison sociale normalisée" : "";
  }
  if (criterion.kind === "name_address") {
    const sameName = equal(normalizeName(left.data.name ?? left.title), normalizeName(right.data.name ?? right.title));
    const sameAddress = equal(normalizeName(left.data.address), normalizeName(right.data.address));
    return sameName && sameAddress ? "nom + adresse normalisés" : "";
  }
  if (criterion.kind === "name_email") {
    const sameName = equal(normalizeName(left.data.name ?? left.title), normalizeName(right.data.name ?? right.title));
    const a = normalizeEmail(left.data.email); const b = normalizeEmail(right.data.email);
    return sameName && equal(a, b) ? `nom + ${maskEmail(a)}` : "";
  }
  if (criterion.kind === "business_id" && criterion.field) {
    const a = normalizeIdentifier(left.data[criterion.field]); const b = normalizeIdentifier(right.data[criterion.field]);
    return equal(a, b) ? `${criterion.field} concordant` : "";
  }
  return "";
}

function normalizeEmail(value: unknown) { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function normalizePhone(value: unknown) { if (typeof value !== "string" && typeof value !== "number") return ""; const digits = String(value).replace(/\D/g, ""); return digits.length >= 7 ? digits.replace(/^00/, "") : ""; }
function normalizeName(value: unknown) { if (typeof value !== "string") return ""; return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(sas|sarl|sa|eurl|ltd|llc|inc|corp|company)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "); }
function normalizeIdentifier(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value).toUpperCase().replace(/[^A-Z0-9]/g, "") : ""; }
function equal(a: string, b: string) { return Boolean(a && b && a === b); }
function maskEmail(value: string) { const [left, domain] = value.split("@"); return domain ? `${left.slice(0, 2)}***@${domain}` : "e-mail concordant"; }
function maskPhone(value: string) { return value ? `***${value.slice(-4)}` : "téléphone concordant"; }
function clampWeight(value: unknown) { const n = Number(value ?? 10); return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 10; }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return null; } }
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
