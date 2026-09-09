import assert from "node:assert/strict";

const actor = {
  userId: "u-admin",
  email: "admin@example.test",
  displayName: "Admin",
  tenantId: "t1",
  teamId: "team-a",
  role: "admin",
};

function canUseResource(currentActor, scope, resource) {
  if (resource.tenantId !== currentActor.tenantId) return false;
  if (scope === "tenant") return true;
  if (scope === "team") return resource.teamId === currentActor.teamId;
  return resource.ownerId === currentActor.userId;
}

assert.equal(canUseResource(actor, "tenant", { tenantId: "t1", teamId: "team-b", ownerId: "u2" }), true);
assert.equal(canUseResource(actor, "tenant", { tenantId: "t2", teamId: "team-a", ownerId: "u-admin" }), false);
assert.equal(canUseResource(actor, "team", { tenantId: "t1", teamId: "team-a", ownerId: "u2" }), true);
assert.equal(canUseResource(actor, "team", { tenantId: "t1", teamId: "team-b", ownerId: "u-admin" }), false);
assert.equal(canUseResource(actor, "personal", { tenantId: "t1", teamId: "team-b", ownerId: "u-admin" }), true);
assert.equal(canUseResource(actor, "personal", { tenantId: "t1", teamId: "team-a", ownerId: "u2" }), false);

console.log("authz scope tests: ok");
