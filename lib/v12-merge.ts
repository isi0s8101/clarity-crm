import { getPool } from "@/db";
import { audit, requireRecordPermission, type AuthContext } from "@/lib/authz";
import { getCrmRecord } from "@/lib/crm-core";
import { V12ConflictError, V12NotFoundError, V12ValidationError } from "@/lib/v12-planning";

const SUPPORTED_TYPES = new Set(["contact", "company", "lead", "opportunity"]);
const REF_FIELDS = ["companyId", "contactId", "leadId", "opportunityId", "quoteId", "invoiceId", "contractId", "productId", "serviceId", "parentId"];

export async function previewMerge(actor: AuthContext, primaryId: string, secondaryId: string) {
  if (!primaryId || !secondaryId || primaryId === secondaryId) throw new V12ValidationError("Deux fiches distinctes sont requises.");
  const primary = await getCrmRecord(actor, primaryId, "read");
  const secondary = await getCrmRecord(actor, secondaryId, "read");
  assertCompatible(primary.type, secondary.type);
  const fields = new Set([...Object.keys(primary.data), ...Object.keys(secondary.data)]);
  const comparison = [...fields].sort().map((field) => {
    const left = primary.data[field];
    const right = secondary.data[field];
    return {
      field,
      primary: left ?? null,
      secondary: right ?? null,
      conflict: left !== undefined && right !== undefined && JSON.stringify(left) !== JSON.stringify(right),
      suggested: left === undefined && right !== undefined ? "secondary" : "primary",
    };
  });
  return {
    primary: summarize(primary),
    secondary: summarize(secondary),
    comparison,
    impact: await mergeImpact(actor.tenantId, primary.id, secondary.id),
    warnings: [
      "La fiche secondaire sera archivée et référencera la fiche résultante.",
      "La fusion exige une confirmation explicite et n'est jamais automatique.",
    ],
  };
}

export async function mergeRecords(actor: AuthContext, input: {
  primaryId: string;
  secondaryId: string;
  resolution?: Record<string, unknown>;
  confirm: boolean;
}) {
  if (input.confirm !== true) throw new V12ValidationError("Confirmation explicite de fusion requise.");
  if (input.primaryId === input.secondaryId) throw new V12ValidationError("Deux fiches distinctes sont requises.");
  const primary = await getCrmRecord(actor, input.primaryId, "update");
  const secondary = await getCrmRecord(actor, input.secondaryId, "update");
  await requireRecordPermission(actor, secondary.type, "delete");
  await getCrmRecord(actor, secondary.id, "delete");
  assertCompatible(primary.type, secondary.type);
  if (secondary.status === "archived" || secondary.data.mergedIntoId) throw new V12ConflictError("La fiche secondaire n'est plus fusionnable.");

  const preview = await previewMerge(actor, primary.id, secondary.id);
  const resolution = normalizeResolution(input.resolution ?? {}, primary.data, secondary.data);
  const mergedData: Record<string, unknown> = { ...primary.data };
  for (const field of new Set([...Object.keys(primary.data), ...Object.keys(secondary.data)])) {
    const choice = resolution[field];
    if (choice === "secondary") mergedData[field] = secondary.data[field];
    else if (isExplicit(choice)) mergedData[field] = choice.value;
    else if (mergedData[field] === undefined && secondary.data[field] !== undefined) mergedData[field] = secondary.data[field];
  }
  mergedData.mergeSources = [...new Set([...stringArray(primary.data.mergeSources), secondary.id])].slice(0, 100);
  const now = new Date().toISOString();
  const secondaryData = { ...secondary.data, mergedIntoId: primary.id, mergedAt: now };
  const ledgerId = crypto.randomUUID();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id,status FROM crm_records WHERE tenant_id=$1 AND id=ANY($2::text[]) FOR UPDATE`,
      [actor.tenantId, [primary.id, secondary.id]],
    );
    if (locked.rows.length !== 2) throw new V12NotFoundError("Une fiche à fusionner n'existe plus.");
    const secondaryState = locked.rows.find((row) => row.id === secondary.id);
    if (secondaryState?.status === "archived") throw new V12ConflictError("La fiche secondaire n'est plus fusionnable.");

    await client.query(`UPDATE crm_records SET data=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify(mergedData), now, actor.tenantId, primary.id]);
    await client.query(`UPDATE crm_records SET status='archived',data=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4`, [JSON.stringify(secondaryData), now, actor.tenantId, secondary.id]);

    const relations = await client.query(
      `SELECT id,from_record_id,to_record_id,relation_type,created_by,created_at
       FROM crm_relations WHERE tenant_id=$1 AND (from_record_id=$2 OR to_record_id=$2) FOR UPDATE`,
      [actor.tenantId, secondary.id],
    );
    for (const relation of relations.rows) {
      const from = relation.from_record_id === secondary.id ? primary.id : relation.from_record_id;
      const to = relation.to_record_id === secondary.id ? primary.id : relation.to_record_id;
      if (from !== to) {
        await client.query(
          `INSERT INTO crm_relations(id,tenant_id,from_record_id,to_record_id,relation_type,created_by,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,from_record_id,to_record_id,relation_type) DO NOTHING`,
          [crypto.randomUUID(), actor.tenantId, from, to, relation.relation_type, relation.created_by, relation.created_at],
        );
      }
      await client.query(`DELETE FROM crm_relations WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, relation.id]);
    }

    await client.query(`UPDATE crm_timeline_events SET record_id=$1 WHERE tenant_id=$2 AND record_id=$3`, [primary.id, actor.tenantId, secondary.id]);
    await client.query(`UPDATE crm_documents SET record_id=$1 WHERE tenant_id=$2 AND record_id=$3`, [primary.id, actor.tenantId, secondary.id]);
    await client.query(`UPDATE crm_inbox_conversations SET related_record_id=$1,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$2 AND related_record_id=$3`, [primary.id, actor.tenantId, secondary.id]);

    for (const field of REF_FIELDS) {
      await client.query(
        `UPDATE crm_records
         SET data=jsonb_set(data::jsonb, ARRAY[$1]::text[], to_jsonb($2::text), false)::text,updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$3 AND id<>$4 AND data::jsonb ->> $1=$5`,
        [field, primary.id, actor.tenantId, secondary.id, secondary.id],
      );
    }

    const result = {
      primaryId: primary.id,
      secondaryId: secondary.id,
      secondaryStatus: "archived",
      relationsPreserved: true,
      timelinePreserved: true,
      documentsPreserved: true,
      referencesReassigned: true,
    };
    await client.query(
      `INSERT INTO crm_merge_ledger(id,tenant_id,primary_record_id,secondary_record_id,actor_id,preview,resolution,result,created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
      [ledgerId, actor.tenantId, primary.id, secondary.id, actor.userId, JSON.stringify(preview), JSON.stringify(resolution), JSON.stringify(result), now],
    );
    await client.query(
      `INSERT INTO crm_timeline_events(tenant_id,team_id,owner_id,record_id,event_type,summary,data,actor_id,created_at)
       VALUES ($1,$2,$3,$4,'records.merged',$5,$6,$7,$8)`,
      [actor.tenantId, primary.teamId, primary.ownerId, primary.id,
        `Fusion de « ${secondary.title} » dans « ${primary.title} »`, JSON.stringify({ ledgerId, secondaryId: secondary.id }), actor.userId, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await audit(actor, {
    action: "crm_records.merged",
    resourceType: primary.type,
    resourceId: primary.id,
    result: "success",
    before: { primary, secondary },
    after: { primaryId: primary.id, secondaryId: secondary.id, secondaryStatus: "archived" },
    details: { ledgerId, resolution },
  });
  return { ledgerId, primaryId: primary.id, secondaryId: secondary.id, secondaryStatus: "archived" };
}

async function mergeImpact(tenantId: string, primaryId: string, secondaryId: string) {
  const [relations, timeline, documents, refs, inbox] = await Promise.all([
    getPool().query(`SELECT count(*)::int AS count FROM crm_relations WHERE tenant_id=$1 AND (from_record_id=$2 OR to_record_id=$2)`, [tenantId, secondaryId]),
    getPool().query(`SELECT count(*)::int AS count FROM crm_timeline_events WHERE tenant_id=$1 AND record_id=$2`, [tenantId, secondaryId]),
    getPool().query(`SELECT count(*)::int AS count FROM crm_documents WHERE tenant_id=$1 AND record_id=$2`, [tenantId, secondaryId]),
    getPool().query(`SELECT count(*)::int AS count FROM crm_records WHERE tenant_id=$1 AND id<>ALL($2::text[]) AND data::text LIKE $3`, [tenantId, [primaryId, secondaryId], `%${secondaryId}%`]),
    getPool().query(`SELECT count(*)::int AS count FROM crm_inbox_conversations WHERE tenant_id=$1 AND related_record_id=$2`, [tenantId, secondaryId]),
  ]);
  return {
    relations: Number(relations.rows[0]?.count ?? 0), timelineEvents: Number(timeline.rows[0]?.count ?? 0),
    documents: Number(documents.rows[0]?.count ?? 0), referencedRecords: Number(refs.rows[0]?.count ?? 0),
    inboxConversations: Number(inbox.rows[0]?.count ?? 0),
  };
}

function normalizeResolution(input: Record<string, unknown>, primary: Record<string, unknown>, secondary: Record<string, unknown>) {
  const allowed = new Set([...Object.keys(primary), ...Object.keys(secondary)]);
  const output: Record<string, "primary" | "secondary" | { value: unknown }> = {};
  for (const [field, raw] of Object.entries(input)) {
    if (!allowed.has(field) || field.length > 80) throw new V12ValidationError(`Résolution de champ inconnue : ${field}.`);
    if (raw === "primary" || raw === "secondary") { output[field] = raw; continue; }
    const item = asObject(raw);
    if (item && "value" in item && scalar(item.value)) { output[field] = { value: item.value }; continue; }
    throw new V12ValidationError(`Résolution invalide pour ${field}.`);
  }
  return output;
}

function assertCompatible(primaryType: string, secondaryType: string) {
  if (primaryType !== secondaryType || !SUPPORTED_TYPES.has(primaryType)) throw new V12ConflictError("La fusion exige deux fiches compatibles du même type.");
}
function summarize(record: { id: string; type: string; title: string; status: string; data: Record<string, unknown>; ownerId: string; teamId: string; updatedAt: string }) {
  return { id: record.id, type: record.type, title: record.title, status: record.status, data: record.data, ownerId: record.ownerId, teamId: record.teamId, updatedAt: record.updatedAt };
}
function isExplicit(value: unknown): value is { value: unknown } { return Boolean(value && typeof value === "object" && !Array.isArray(value) && "value" in (value as Record<string, unknown>)); }
function scalar(value: unknown) { return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
