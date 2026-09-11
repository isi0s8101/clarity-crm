import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export class DocumentValidationError extends Error {
  status = 400;
}

export function documentStorageRoot() {
  const configured = process.env.CLARITY_DOCUMENTS_DIR?.trim() || "/var/lib/clarity-crm/documents";
  if (!path.isAbsolute(configured)) throw new DocumentValidationError("Répertoire documentaire absolu requis.");
  return path.resolve(configured);
}

export function normalizeDocumentName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return normalized || null;
}

export async function storeDocument(tenantId: string, file: File) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(tenantId)) {
    throw new DocumentValidationError("Tenant documentaire invalide.");
  }
  const originalName = normalizeDocumentName(file.name);
  if (!originalName) throw new DocumentValidationError("Nom de fichier invalide.");
  if (!ALLOWED_MIME_TYPES.has(file.type)) throw new DocumentValidationError("Type de fichier non autorisé.");
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentValidationError("Taille de fichier invalide ou trop importante.");
  }

  const content = Buffer.from(await file.arrayBuffer());
  if (content.length !== file.size) throw new DocumentValidationError("Lecture du fichier incomplète.");
  const id = randomUUID();
  const storageKey = `${tenantId}/${id}`;
  const destination = resolveStoragePath(storageKey);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.upload-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    id,
    storageKey,
    originalName,
    normalizedName: originalName,
    mimeType: file.type,
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export async function readStoredDocument(storageKey: string) {
  return readFile(resolveStoragePath(storageKey));
}

export async function discardStoredDocument(storageKey: string) {
  await unlink(resolveStoragePath(storageKey)).catch(() => undefined);
}

function resolveStoragePath(storageKey: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}\/[0-9a-f-]{36}$/.test(storageKey)) {
    throw new DocumentValidationError("Clé documentaire invalide.");
  }
  const root = documentStorageRoot();
  const candidate = path.resolve(root, storageKey);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new DocumentValidationError("Chemin documentaire refusé.");
  return candidate;
}
