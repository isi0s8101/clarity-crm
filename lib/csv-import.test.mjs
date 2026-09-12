import assert from "node:assert/strict";
import { CsvImportError, decodeUtf8Csv, normalizeMapping, parseCsv, rowsToRecords } from "./csv-import.js";

const parsed = parseCsv('Nom,Statut,Email\n"Acme, SAS",active,hello@example.test\n');
assert.deepEqual(parsed.headers, ["Nom", "Statut", "Email"]);
const mapping = normalizeMapping(parsed.headers, {});
assert.equal(mapping.Nom, "title");
assert.equal(mapping.Statut, "status");
assert.equal(mapping.Email, "email");
assert.equal(rowsToRecords(parsed.headers, parsed.rows, mapping).records[0].title, "Acme, SAS");
assert.throws(() => parseCsv('title\n"unterminated'), CsvImportError);
assert.throws(() => decodeUtf8Csv(new Uint8Array([0xc3, 0x28])), CsvImportError);
console.log("csv-import tests passed");
