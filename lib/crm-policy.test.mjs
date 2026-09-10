import assert from "node:assert/strict";

import {
  CORE_RECORD_TYPES,
  calculateCommercialDocument,
  evaluateAutomationConditions,
  extractKnownRecordRefs,
  normalizeRecordType,
  normalizeWebhookUrl,
  validateConfiguration,
  validateRecordInput,
} from "./crm-policy.js";

assert.equal(CORE_RECORD_TYPES.length, 13);
assert.equal(normalizeRecordType(" Opportunity "), "opportunity");
assert.equal(normalizeRecordType("../../etc/passwd"), null);

for (const type of CORE_RECORD_TYPES) {
  let data = {};
  if (type === "note") data = { body: "Note" };
  if (type === "appointment") data = { startsAt: "2026-09-10T10:00:00Z", endsAt: "2026-09-10T11:00:00Z" };
  if (type === "quote" || type === "invoice") {
    data = { currency: "EUR", lines: [{ description: "Service", quantity: 2, unitPriceCents: 10000, taxRateBasisPoints: 2000 }] };
  }
  const result = validateRecordInput({ type, title: `Test ${type}`, data });
  assert.equal(result.ok, true, `Type ${type} doit être accepté.`);
}

const quote = calculateCommercialDocument({
  currency: "eur",
  subtotalCents: 1,
  totalCents: 1,
  lines: [
    { description: "Audit", quantity: 2, unitPriceCents: 10000, taxRateBasisPoints: 2000 },
    { description: "Support", quantity: 1, unitPriceCents: 5000, taxRateBasisPoints: 0 },
  ],
});
assert.equal(quote.currency, "EUR");
assert.equal(quote.subtotalCents, 25000);
assert.equal(quote.taxCents, 4000);
assert.equal(quote.totalCents, 29000);
assert.equal(quote.lines[0].totalCents, 24000);

assert.equal(
  validateRecordInput({
    type: "invoice",
    title: "Facture",
    data: { lines: [{ description: "X", quantity: -1, unitPriceCents: 100 }] },
  }).ok,
  false,
);
assert.equal(
  validateRecordInput({
    type: "appointment",
    title: "RDV",
    data: { startsAt: "2026-09-10T11:00:00Z", endsAt: "2026-09-10T10:00:00Z" },
  }).ok,
  false,
);

assert.deepEqual(
  extractKnownRecordRefs({ companyId: "c1", contactId: "p1", nested: { companyId: "ignored" }, parentId: "c1" }),
  ["c1", "p1"],
);

assert.equal(
  validateConfiguration("object", {
    key: "vehicle",
    label: "Véhicule",
    fields: [
      { key: "registration", label: "Immatriculation", type: "text" },
      { key: "mileage", label: "Kilométrage", type: "number" },
    ],
  }).ok,
  true,
);
assert.equal(
  validateConfiguration("object", {
    key: "vehicle",
    label: "Véhicule",
    fields: [
      { key: "registration", label: "A", type: "text" },
      { key: "registration", label: "B", type: "text" },
    ],
  }).ok,
  false,
);
assert.equal(
  validateConfiguration("pipeline", {
    key: "sales",
    objectType: "opportunity",
    stages: [{ key: "new", label: "Nouveau" }, { key: "won", label: "Gagné" }],
  }).ok,
  true,
);
assert.equal(
  validateConfiguration("form", {
    key: "contact_form",
    objectType: "contact",
    fields: [{ key: "title" }, { key: "email" }],
  }).ok,
  true,
);
assert.equal(
  validateConfiguration("automation", {
    key: "followup",
    trigger: { event: "record.created", type: "opportunity" },
    conditions: [{ field: "status", operator: "eq", value: "active" }],
    actions: [{ kind: "create_task", title: "Suivre {{title}}" }],
  }).ok,
  true,
);
assert.equal(
  validateConfiguration("automation", {
    key: "unsafe",
    trigger: { event: "record.created" },
    actions: [{ kind: "shell", command: "rm -rf /" }],
  }).ok,
  false,
);
assert.equal(
  validateConfiguration("module", { key: "billing", dependsOn: ["billing"] }).ok,
  false,
);
assert.equal(
  validateConfiguration("webhook", { key: "crm_sync", direction: "outbound", event: "record.created", url: "https://example.com/hook" }).ok,
  true,
);

const record = { type: "opportunity", title: "Projet A", status: "active", data: { amountCents: 50000, region: "FR" } };
assert.equal(evaluateAutomationConditions([{ field: "status", operator: "eq", value: "active" }], record), true);
assert.equal(evaluateAutomationConditions([{ field: "amountCents", operator: "gt", value: 10000 }], record), true);
assert.equal(evaluateAutomationConditions([{ field: "region", operator: "contains", value: "fr" }], record), true);
assert.equal(evaluateAutomationConditions([{ field: "amountCents", operator: "lt", value: 100 }], record), false);

assert.equal(normalizeWebhookUrl("https://example.com/hook"), "https://example.com/hook");
assert.equal(normalizeWebhookUrl("http://example.com/hook"), null);
assert.equal(normalizeWebhookUrl("https://127.0.0.1/hook"), null);
assert.equal(normalizeWebhookUrl("https://10.0.0.1/hook"), null);
assert.equal(normalizeWebhookUrl("https://192.168.1.10/hook"), null);
assert.equal(normalizeWebhookUrl("http://127.0.0.1:9999/hook", { allowPrivate: true }), "http://127.0.0.1:9999/hook");

console.log("crm policy tests: ok");
