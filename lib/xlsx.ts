const encoder = new TextEncoder();

type Entry = { name: string; content: Uint8Array };

export function createXlsx(rows: Array<Array<unknown>>) {
  const worksheetRows = rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => cell(column + 1, index + 1, safeSpreadsheetValue(value))).join("")}</row>`).join("");
  return zip([
    { name: "[Content_Types].xml", content: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
    { name: "_rels/.rels", content: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: "xl/workbook.xml", content: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="CRM" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: "xl/_rels/workbook.xml.rels", content: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: "xl/worksheets/sheet1.xml", content: text(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${worksheetRows}</sheetData></worksheet>`) },
  ]);
}

export function safeSpreadsheetValue(value: unknown) {
  const string = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /^[=+\-@]/.test(string) ? `'${string}` : string;
}

function cell(column: number, row: number, value: string) {
  return `<c r="${columnName(column)}${row}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function columnName(column: number) {
  let value = column;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function escapeXml(value: string) {
  return value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character] ?? character);
}

function text(value: string) { return encoder.encode(value); }

function zip(entries: Entry[]) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = text(entry.name);
    const crc = crc32(entry.content);
    const local = new Uint8Array(30 + name.length + entry.content.length);
    write32(local, 0, 0x04034b50); write16(local, 4, 20); write16(local, 6, 0); write16(local, 8, 0);
    write32(local, 14, crc); write32(local, 18, entry.content.length); write32(local, 22, entry.content.length); write16(local, 26, name.length); write16(local, 28, 0);
    local.set(name, 30); local.set(entry.content, 30 + name.length); locals.push(local);
    const central = new Uint8Array(46 + name.length);
    write32(central, 0, 0x02014b50); write16(central, 4, 20); write16(central, 6, 20); write16(central, 8, 0); write16(central, 10, 0);
    write32(central, 16, crc); write32(central, 20, entry.content.length); write32(central, 24, entry.content.length); write16(central, 28, name.length); write16(central, 30, 0); write16(central, 32, 0); write32(central, 42, offset);
    central.set(name, 46); centrals.push(central); offset += local.length;
  }
  const centralLength = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  write32(end, 0, 0x06054b50); write16(end, 8, entries.length); write16(end, 10, entries.length); write32(end, 12, centralLength); write32(end, 16, offset);
  return combine([...locals, ...centrals, end]);
}

function combine(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function write16(output: Uint8Array, offset: number, value: number) { output[offset] = value & 255; output[offset + 1] = (value >>> 8) & 255; }
function write32(output: Uint8Array, offset: number, value: number) { write16(output, offset, value); write16(output, offset + 2, value >>> 16); }
function crc32(input: Uint8Array) { let crc = 0xffffffff; for (const byte of input) { crc ^= byte; for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
