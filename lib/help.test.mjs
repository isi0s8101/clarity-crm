import assert from "node:assert/strict";

import { helpCatalog } from "./help/catalog-all.js";
import { searchHelp } from "./help/search.js";
import { filterProcedures, getProcedure, recommendProcedures } from "./help/resolver.js";
import { normalizeProgress, progressStorageKey } from "./help/progress.js";

const validRoles = new Set(["client", "user", "admin"]);
const ids = new Set();

for (const procedure of helpCatalog) {
  assert.match(procedure.id, /^(COM|USR|ADM|HELP)-[A-Z0-9-]+-\d{3}$/u, `id invalide: ${procedure.id}`);
  assert.equal(ids.has(procedure.id), false, `id dupliqué: ${procedure.id}`);
  ids.add(procedure.id);
  assert.equal(Number.isInteger(procedure.version) && procedure.version > 0, true, `version invalide: ${procedure.id}`);
  assert.equal(Array.isArray(procedure.roles) && procedure.roles.length > 0, true, `roles absents: ${procedure.id}`);
  for (const role of procedure.roles) assert.equal(validRoles.has(role), true, `role invalide: ${procedure.id}`);
  assert.equal(Array.isArray(procedure.steps) && procedure.steps.length > 0, true, `steps absentes: ${procedure.id}`);
  assert.equal(typeof procedure.result, "string", `result absent: ${procedure.id}`);
}

for (const procedure of helpCatalog) {
  for (const prerequisite of procedure.prerequisites) {
    assert.equal(ids.has(prerequisite), true, `prérequis inexistant ${prerequisite} dans ${procedure.id}`);
  }
}

function visit(id, path = []) {
  assert.equal(path.includes(id), false, `cycle de prérequis: ${[...path, id].join(" -> ")}`);
  const procedure = getProcedure(id);
  for (const prerequisite of procedure?.prerequisites ?? []) visit(prerequisite, [...path, id]);
}

for (const id of ids) visit(id);

const userContext = {
  view: "config",
  role: "user",
  permissions: [
    { object: "crm_record", action: "read", scope: "team" },
    { object: "crm_record", action: "create", scope: "team" },
    { object: "timeline", action: "read", scope: "team" },
  ],
};
const adminContext = {
  view: "config",
  role: "admin",
  permissions: [
    { object: "crm_configuration", action: "administer", scope: "tenant" },
    { object: "admin", action: "administer", scope: "tenant" },
    { object: "webhook", action: "administer", scope: "tenant" },
    { object: "automation", action: "administer", scope: "tenant" },
    { object: "module", action: "administer", scope: "tenant" },
    { object: "portal", action: "administer", scope: "tenant" },
  ],
};
const clientContext = {
  view: "portal",
  role: "client",
  permissions: [
    { object: "portal", action: "read", scope: "personal" },
    { object: "portal", action: "create", scope: "personal" },
    { object: "portal", action: "update", scope: "personal" },
  ],
};

assert.equal(filterProcedures(userContext).some((item) => item.id.startsWith("ADM-")), false, "un utilisateur ne doit pas voir les procédures admin réalisables");
assert.equal(filterProcedures(adminContext).some((item) => item.id.startsWith("ADM-")), true, "un admin doit voir les procédures admin");
assert.equal(filterProcedures({ ...userContext, permissions: [{ object: "crm_record", action: "read", scope: "team" }] }).some((item) => item.title.startsWith("Créer une fiche")), false, "filtrage permission create KO");
const clientVisible = filterProcedures(clientContext);
assert.equal(clientVisible.some((item) => item.id === "USR-V11-PORTAL-001"), true, "aide portail client absente");
assert.equal(clientVisible.some((item) => item.roles.includes("user") || item.roles.includes("admin")), false, "un client ne doit pas hériter de l'aide interne");
assert.equal(filterProcedures({ ...clientContext, permissions: [] }).some((item) => item.id === "USR-V11-PORTAL-001"), false, "l'aide portail doit respecter la permission read");

const searchResults = searchHelp("import csv", { ...adminContext, view: "crm", permissions: [{ object: "crm_record", action: "create", scope: "tenant" }] });
assert.equal(searchResults.some((item) => item.id === "USR-IMP-001"), true, "recherche import CSV KO");
const clientSearch = searchHelp("portail client", clientContext);
assert.equal(clientSearch.some((item) => item.id === "USR-V11-PORTAL-001"), true, "recherche aide portail KO");

const recommendations = recommendProcedures({ ...adminContext, view: "webhooks" }, 4);
assert.equal(recommendations.length <= 4, true, "plus de 4 recommandations");
assert.equal(recommendations.some((item) => item.contexts.includes("webhooks")), true, "résolution contextuelle webhooks KO");

const procedure = getProcedure("USR-IMP-001");
assert.ok(procedure, "procédure USR-IMP-001 absente");
assert.equal(progressStorageKey("USR-IMP-001"), "clarity.help.progress.USR-IMP-001", "clé localStorage invalide");
assert.deepEqual(normalizeProgress({ version: procedure.version, step: 3, completed: false }, procedure), { version: procedure.version, step: 3, completed: false }, "récupération progression KO");
assert.deepEqual(normalizeProgress({ version: procedure.version + 1, step: 3, completed: false }, procedure), { version: procedure.version, step: 0, completed: false }, "invalidation version KO");
assert.ok(getProcedure("ADM-REL-001"), "procédure relations configurables absente");
assert.ok(getProcedure("HELP-ERR-007"), "dépannage configuration v0.3 absent");
assert.ok(getProcedure("ADM-V11-MOD-001"), "procédure modules v1.1 absente");
assert.ok(getProcedure("HELP-V11-PORTAL-001"), "dépannage portail v1.1 absent");

console.log(`help tests ok (${helpCatalog.length} procédures)`);
