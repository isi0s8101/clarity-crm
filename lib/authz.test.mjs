import assert from "node:assert/strict";

import { resolveAccessSelection } from "./access-resolution.js";
import { canUseScopedResource, normalizeTenantSelector, tenantSelectorFromHeaders } from "./authz-policy.js";

const actor = { userId: "u-admin", email: "admin@example.test", displayName: "Admin", tenantId: "t1", teamId: "team-a", role: "admin" };
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

assert.deepEqual(tenantSelectorFromHeaders(new Headers({ "x-clarity-tenant-id": "tenant-01", cookie: "clarity_tenant=tenant-cookie" })), { present: true, value: "tenant-01" });
assert.deepEqual(tenantSelectorFromHeaders(new Headers({ cookie: "other=value; clarity_tenant=tenant%3Aeu.fr" })), { present: true, value: "tenant:eu.fr" });
assert.deepEqual(tenantSelectorFromHeaders(new Headers({ cookie: "clarity_tenant=..%2F..%2Fetc%2Fpasswd" })), { present: true, value: null });
assert.deepEqual(tenantSelectorFromHeaders(new Headers()), { present: false, value: null });

const memberT1 = { tenantId: "t1", status: "active" };
const memberT2 = { tenantId: "t2", status: "active" };
const inviteT2 = { tenantId: "t2", status: "pending" };
assert.deepEqual(resolveAccessSelection({ tenantSelector: null, memberships: [], pendingInvitations: [] }), { kind: "denied", reason: "invitation_required" });
assert.deepEqual(resolveAccessSelection({ tenantSelector: null, memberships: [], pendingInvitations: [inviteT2] }), { kind: "invitation", invitation: inviteT2 });
assert.deepEqual(resolveAccessSelection({ tenantSelector: null, memberships: [memberT1], pendingInvitations: [] }), { kind: "membership", membership: memberT1 });
assert.deepEqual(resolveAccessSelection({ tenantSelector: null, memberships: [memberT1, memberT2], pendingInvitations: [] }), { kind: "denied", reason: "tenant_selection_required" });
assert.deepEqual(resolveAccessSelection({ tenantSelector: "t2", memberships: [memberT1, memberT2], pendingInvitations: [] }), { kind: "membership", membership: memberT2 });
assert.deepEqual(resolveAccessSelection({ tenantSelector: "t3", memberships: [memberT1, memberT2], pendingInvitations: [inviteT2] }), { kind: "denied", reason: "tenant_access_denied" });

console.log("authz production policy tests: ok");
