import assert from "node:assert/strict";

import { canUseScopedResource, normalizeTenantSelector } from "./authz-policy.js";

const actor = {
  userId: "u-admin",
  email: "admin@example.test",
  displayName: "Admin",
  tenantId: "t1",
  teamId: "team-a",
  role: "admin",
};

assert.equal(canUseScopedResource(actor, "tenant", { tenantId: "t1", teamId: "team-b", ownerId: "u2" }), true);
assert.equal(canUseScopedResource(actor, "tenant", { tenantId: "t2", teamId: "team-a", ownerId: "u-admin" }), false);
assert.equal(canUseScopedResource(actor, "team", { tenantId: "t1", teamId: "team-a", ownerId: "u2" }), true);
assert.equal(canUseScopedResource(actor, "team", { tenantId: "t1", teamId: "team-b", ownerId: "u-admin" }), false);
assert.equal(canUseScopedResource(actor, "personal", { tenantId: "t1", teamId: "team-b", ownerId: "u-admin" }), true);
assert.equal(canUseScopedResource(actor, "personal", { tenantId: "t1", teamId: "team-a", ownerId: "u2" }), false);
assert.equal(canUseScopedResource(actor, "unknown", { tenantId: "t1", teamId: "team-a", ownerId: "u-admin" }), false);

assert.equal(normalizeTenantSelector("tenant-01"), "tenant-01");
assert.equal(normalizeTenantSelector(" tenant:eu.fr "), "tenant:eu.fr");
assert.equal(normalizeTenantSelector("../../etc/passwd"), null);
assert.equal(normalizeTenantSelector(""), null);
assert.equal(normalizeTenantSelector("a".repeat(101)), null);

console.log("authz production policy tests: ok");
