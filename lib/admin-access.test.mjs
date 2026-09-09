import assert from "node:assert/strict";

function canUpdateMember(actorUserId, targetUserId, nextRole) {
  return !(actorUserId === targetUserId && nextRole !== "admin");
}

function canSetStatus(actorUserId, targetUserId, nextStatus) {
  return !(actorUserId === targetUserId && nextStatus !== "active");
}

function canSetPermission(role, object) {
  return !(role === "user" && object === "admin");
}

function validEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

assert.equal(canUpdateMember("u1", "u1", "user"), false);
assert.equal(canUpdateMember("u1", "u1", "admin"), true);
assert.equal(canUpdateMember("u1", "u2", "user"), true);
assert.equal(canSetStatus("u1", "u1", "disabled"), false);
assert.equal(canSetStatus("u1", "u2", "disabled"), true);
assert.equal(canSetPermission("user", "admin"), false);
assert.equal(canSetPermission("admin", "admin"), true);
assert.equal(validEmail("admin@example.test"), true);
assert.equal(validEmail("bad-email"), false);

console.log("admin access tests: ok");
