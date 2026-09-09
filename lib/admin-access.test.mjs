import assert from "node:assert/strict";

function canUpdateMember(actorUserId, targetUserId, nextRole) {
  return !(actorUserId === targetUserId && nextRole !== "admin");
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
assert.equal(canSetPermission("user", "admin"), false);
assert.equal(canSetPermission("admin", "admin"), true);
assert.equal(validEmail("admin@example.test"), true);
assert.equal(validEmail("bad-email"), false);

console.log("admin access tests: ok");
