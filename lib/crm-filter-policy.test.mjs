import assert from "node:assert/strict";

import { CrmFilterValidationError, parseCrmFilters } from "./crm-filter-policy.js";

assert.deepEqual(parseCrmFilters({
  logic: "and",
  rules: [
    { field: "title", operator: "contains", value: "Alpha" },
    { field: "data.amountCents", operator: "gte", value: 1000 },
  ],
}), {
  logic: "and",
  rules: [
    { field: "title", operator: "contains", value: "Alpha" },
    { field: "data.amountCents", operator: "gte", value: 1000 },
  ],
});
assert.equal(parseCrmFilters(undefined), undefined);
assert.throws(() => parseCrmFilters({ logic: "or", rules: [{ field: "tenantId", operator: "eq", value: "foreign" }] }), CrmFilterValidationError);
assert.throws(() => parseCrmFilters({ logic: "and", rules: [{ field: "data.amount;DROP", operator: "eq", value: 1 }] }), CrmFilterValidationError);
assert.throws(() => parseCrmFilters({ logic: "and", rules: [{ field: "createdAt", operator: "before", value: "not-a-date" }] }), CrmFilterValidationError);
assert.throws(() => parseCrmFilters({ logic: "and", rules: Array.from({ length: 21 }, () => ({ field: "title", operator: "exists" })) }), CrmFilterValidationError);

console.log("crm filter policy tests: ok");
