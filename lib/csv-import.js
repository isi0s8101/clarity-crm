const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

export class CsvImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function decodeUtf8Csv(bytes) {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new CsvImportError("Le fichier CSV dépasse la limite de 2 Mo.", 413);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new CsvImportError("Le fichier CSV doit être encodé en UTF-8.");
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"'; index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') {
      if (value.length > 0) throw new CsvImportError("Guillemet CSV mal placé.");
      quoted = true;
    } else if (character === ",") {
      row.push(value); value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = "";
    } else if (character !== "\r") {
      value += character;
    }
  }
  if (quoted) throw new CsvImportError("Guillemet CSV non fermé.");
  if (value.length > 0 || row.length > 0) { row.push(value); rows.push(row); }
  if (rows.length < 2) throw new CsvImportError("Le CSV doit contenir un en-tête et une ligne.");
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw new CsvImportError(`Le CSV est limité à ${MAX_IMPORT_ROWS} lignes.`, 413);
  const headers = rows.shift().map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new CsvImportError("Les en-têtes CSV doivent être uniques et non vides.");
  }
  return { headers, rows: rows.filter((line) => line.some((value) => value.trim() !== "")) };
}

export function normalizeMapping(headers, rawMapping) {
  const mapping = rawMapping && typeof rawMapping === "object" && !Array.isArray(rawMapping) ? rawMapping : {};
  const normalized = {};
  for (const header of headers) {
    const target = typeof mapping[header] === "string" ? mapping[header].trim() : defaultTarget(header);
    if (!target) continue;
    if (target !== "title" && target !== "status" && !/^[a-z][a-z0-9_]{0,49}$/.test(target)) {
      throw new CsvImportError(`Mapping invalide pour la colonne ${header}.`);
    }
    if (Object.values(normalized).includes(target)) {
      throw new CsvImportError(`Le champ ${target} est mappé plusieurs fois.`);
    }
    normalized[header] = target;
  }
  if (!Object.values(normalized).includes("title")) throw new CsvImportError("Mappez une colonne vers le titre.");
  return normalized;
}

export function rowsToRecords(headers, rows, mapping) {
  const seenTitles = new Set();
  const records = [];
  const errors = [];
  rows.forEach((row, rowIndex) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? "").trim()]));
    const data = {};
    let title = "";
    let status = "active";
    for (const [header, target] of Object.entries(mapping)) {
      const value = values[header];
      if (target === "title") title = value;
      else if (target === "status") status = value || "active";
      else if (value !== "") data[target] = value;
    }
    const normalizedTitle = title.toLocaleLowerCase();
    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      errors.push({ row: rowIndex + 2, error: "Doublon dans le fichier (titre)." }); return;
    }
    if (normalizedTitle) seenTitles.add(normalizedTitle);
    records.push({ row: rowIndex + 2, title, status, data });
  });
  return { records, errors };
}

function defaultTarget(header) {
  const normalized = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (["title", "name", "nom", "company", "societe", "société"].includes(normalized)) return "title";
  if (["status", "statut"].includes(normalized)) return "status";
  return /^[a-z][a-z0-9_]{0,49}$/.test(normalized) ? normalized : "";
}
