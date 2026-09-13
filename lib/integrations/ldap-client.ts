import net from "node:net";
import tls, { type TLSSocket } from "node:tls";

export type LdapDirectoryConfig = {
  host: string;
  port: number;
  bindDn: string;
  baseDn: string;
  usersBaseDn: string;
  groupsBaseDn: string;
  directoryFlavor: "active_directory" | "generic_ldap";
  userObjectClass: string;
  groupObjectClass: string;
  maxEntries: number;
  timeLimitSeconds: number;
  caPem?: string;
};

export type LdapEntry = {
  dn: string;
  attributes: Record<string, string[]>;
  rawAttributes: Record<string, Buffer[]>;
};

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const ATTRIBUTE_RE = /^[A-Za-z][A-Za-z0-9.-]{0,63}$/;

export async function testLdapBind(config: LdapDirectoryConfig, password: string) {
  const client = await LdapConnection.connect(config);
  try {
    await client.bind(config.bindDn, password);
  } finally {
    client.close();
  }
}

export async function searchLdapDirectory(
  config: LdapDirectoryConfig,
  password: string,
  kind: "users" | "groups",
) {
  const client = await LdapConnection.connect(config);
  try {
    await client.bind(config.bindDn, password);
    const baseDn = kind === "users" ? config.usersBaseDn : config.groupsBaseDn;
    const filter = directoryFilter(config, kind);
    const attributes = kind === "users" ? userAttributes() : groupAttributes();
    return await client.search(baseDn, filter, attributes, config.maxEntries, config.timeLimitSeconds);
  } finally {
    client.close();
  }
}

export function normalizeLdapConfig(value: Record<string, unknown>): LdapDirectoryConfig {
  const host = String(value.host ?? "").trim().toLowerCase();
  if (!isValidHost(host)) throw new LdapClientError("Hôte LDAP invalide.", "ldap_invalid_configuration");
  const port = boundedInteger(value.port, 636, 1, 65535);
  const bindDn = requiredDn(value.bindDn, "Bind DN LDAP invalide.");
  const baseDn = requiredDn(value.baseDn, "Base DN LDAP invalide.");
  const usersBaseDn = optionalDn(value.usersBaseDn) ?? baseDn;
  const groupsBaseDn = optionalDn(value.groupsBaseDn) ?? baseDn;
  const directoryFlavor = value.directoryFlavor === "generic_ldap" ? "generic_ldap" : "active_directory";
  const userObjectClass = ldapToken(value.userObjectClass, directoryFlavor === "active_directory" ? "user" : "inetOrgPerson");
  const groupObjectClass = ldapToken(value.groupObjectClass, directoryFlavor === "active_directory" ? "group" : "groupOfNames");
  const maxEntries = boundedInteger(value.maxEntries, 500, 1, 2000);
  const timeLimitSeconds = boundedInteger(value.timeLimitSeconds, 15, 1, 60);
  const caPem = typeof value.caPem === "string" && value.caPem.trim() ? value.caPem.trim() : undefined;
  if (caPem && Buffer.byteLength(caPem, "utf8") > 128 * 1024) {
    throw new LdapClientError("CA LDAP trop volumineuse.", "ldap_invalid_configuration");
  }
  return { host, port, bindDn, baseDn, usersBaseDn, groupsBaseDn, directoryFlavor, userObjectClass, groupObjectClass, maxEntries, timeLimitSeconds, caPem };
}

export function ldapEntryExternalId(entry: LdapEntry) {
  const guid = entry.rawAttributes.objectguid?.[0];
  if (guid?.length === 16) return `guid:${activeDirectoryGuid(guid)}`;
  const uuid = first(entry.attributes.entryuuid);
  if (uuid) return `uuid:${uuid}`;
  return `dn:${entry.dn}`;
}

export function ldapEntryVersion(entry: LdapEntry) {
  return first(entry.attributes.usnchanged)
    || first(entry.attributes.whenchanged)
    || first(entry.attributes.modifytimestamp)
    || "";
}

class LdapConnection {
  private readonly socket: TLSSocket;
  private buffer = Buffer.alloc(0);
  private readonly messages: Buffer[] = [];
  private readonly waiters: Array<{ resolve: (value: Buffer) => void; reject: (error: Error) => void }> = [];
  private nextMessageId = 1;
  private failure: Error | null = null;

  private constructor(socket: TLSSocket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new LdapClientError("Connexion LDAPS fermée.", "ldap_connection_closed", true)));
  }

  static async connect(config: LdapDirectoryConfig) {
    const socket = tls.connect({
      host: config.host,
      port: config.port,
      ...(net.isIP(config.host) ? {} : { servername: config.host }),
      rejectUnauthorized: true,
      ...(config.caPem ? { ca: [config.caPem] } : {}),
      minVersion: "TLSv1.2",
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new LdapClientError("Timeout de connexion LDAPS.", "ldap_connect_timeout", true));
      }, 10_000);
      socket.once("secureConnect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(new LdapClientError(error.message, "ldap_tls_error", true)); });
    });
    socket.setTimeout(30_000, () => socket.destroy(new Error("LDAP socket timeout")));
    return new LdapConnection(socket);
  }

  async bind(bindDn: string, password: string) {
    if (!password || Buffer.byteLength(password, "utf8") > 16384) {
      throw new LdapClientError("Mot de passe bind LDAP invalide.", "ldap_bind_password_invalid");
    }
    const messageId = this.nextMessageId++;
    const request = application(0, Buffer.concat([
      integer(3),
      octet(bindDn),
      tlv(0x80, Buffer.from(password, "utf8")),
    ]));
    this.socket.write(ldapMessage(messageId, request));
    const message = await this.nextFor(messageId);
    const operation = protocolOperation(message);
    if (operation.tag !== 0x61) throw new LdapClientError("Réponse bind LDAP invalide.", "ldap_bind_invalid_response");
    const result = ldapResult(operation.value);
    if (result.code !== 0) {
      throw new LdapClientError(`Bind LDAP refusé (${result.code}): ${result.diagnostic || "erreur annuaire"}.`, "ldap_bind_failed", false, result.code);
    }
  }

  async search(baseDn: string, filter: Buffer, attributes: string[], sizeLimit: number, timeLimitSeconds: number) {
    const messageId = this.nextMessageId++;
    const attributeList = sequence(...attributes.map((attribute) => octet(attribute)));
    const request = application(3, Buffer.concat([
      octet(baseDn),
      enumeration(2),
      enumeration(0),
      integer(sizeLimit),
      integer(timeLimitSeconds),
      boolean(false),
      filter,
      attributeList,
    ]));
    this.socket.write(ldapMessage(messageId, request));
    const entries: LdapEntry[] = [];
    while (true) {
      const message = await this.nextFor(messageId);
      const operation = protocolOperation(message);
      if (operation.tag === 0x64) {
        entries.push(parseSearchEntry(operation.value));
        if (entries.length > sizeLimit) throw new LdapClientError("Limite d'entrées LDAP dépassée.", "ldap_size_limit");
        continue;
      }
      if (operation.tag === 0x65) {
        const result = ldapResult(operation.value);
        if (result.code === 0) return entries;
        if (result.code === 4) throw new LdapClientError("La recherche LDAP a atteint la limite configurée. Réduire la base ou augmenter maxEntries.", "ldap_size_limit");
        if (result.code === 3) throw new LdapClientError("La recherche LDAP a dépassé sa limite de temps.", "ldap_time_limit", true);
        throw new LdapClientError(`Recherche LDAP refusée (${result.code}): ${result.diagnostic || "erreur annuaire"}.`, "ldap_search_failed", false, result.code);
      }
      if (operation.tag === 0x73) continue;
      throw new LdapClientError("Réponse de recherche LDAP inattendue.", "ldap_search_invalid_response");
    }
  }

  close() {
    if (!this.socket.destroyed) {
      try {
        const messageId = this.nextMessageId++;
        this.socket.write(ldapMessage(messageId, tlv(0x42, Buffer.alloc(0))));
      } catch { /* best effort */ }
      this.socket.end();
    }
  }

  private nextMessage(): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Buffer>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async nextFor(messageId: number) {
    while (true) {
      const message = await this.nextMessage();
      if (messageIdentifier(message) === messageId) return message;
    }
  }

  private onData(chunk: Buffer) {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.socket.destroy(new LdapClientError("Réponse LDAP trop volumineuse.", "ldap_response_too_large"));
      return;
    }
    while (true) {
      const size = completeFrameSize(this.buffer);
      if (size === null || this.buffer.length < size) break;
      const frame = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame); else this.messages.push(frame);
    }
  }

  private fail(error: Error) {
    if (this.failure || this.socket.destroyed && this.waiters.length === 0) return;
    this.failure = error instanceof LdapClientError ? error : new LdapClientError(error.message, "ldap_socket_error", true);
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }
}

function directoryFilter(config: LdapDirectoryConfig, kind: "users" | "groups") {
  if (kind === "groups") return equalityFilter("objectClass", config.groupObjectClass);
  if (config.directoryFlavor === "active_directory") {
    return andFilter(equalityFilter("objectCategory", "person"), equalityFilter("objectClass", config.userObjectClass));
  }
  return equalityFilter("objectClass", config.userObjectClass);
}
function userAttributes() {
  return ["objectGUID", "entryUUID", "uid", "cn", "displayName", "sAMAccountName", "userPrincipalName", "mail", "telephoneNumber", "mobile", "department", "title", "company", "distinguishedName", "uSNChanged", "whenChanged", "modifyTimestamp"];
}
function groupAttributes() {
  return ["objectGUID", "entryUUID", "cn", "mail", "member", "memberOf", "distinguishedName", "uSNChanged", "whenChanged", "modifyTimestamp"];
}
function equalityFilter(attribute: string, value: string) {
  if (!ATTRIBUTE_RE.test(attribute)) throw new LdapClientError("Attribut LDAP invalide.", "ldap_invalid_filter");
  return tlv(0xa3, Buffer.concat([octet(attribute), octet(value)]));
}
function andFilter(...filters: Buffer[]) { return tlv(0xa0, Buffer.concat(filters)); }

function parseSearchEntry(value: Buffer): LdapEntry {
  let offset = 0;
  const dn = readTlv(value, offset); offset = dn.end;
  if (dn.tag !== 0x04) throw new LdapClientError("DN LDAP illisible.", "ldap_invalid_entry");
  const list = readTlv(value, offset);
  if (list.tag !== 0x30) throw new LdapClientError("Attributs LDAP illisibles.", "ldap_invalid_entry");
  const attributes: Record<string, string[]> = {};
  const rawAttributes: Record<string, Buffer[]> = {};
  let attrOffset = 0;
  while (attrOffset < list.value.length) {
    const partial = readTlv(list.value, attrOffset); attrOffset = partial.end;
    if (partial.tag !== 0x30) continue;
    let inner = 0;
    const type = readTlv(partial.value, inner); inner = type.end;
    const values = readTlv(partial.value, inner);
    if (type.tag !== 0x04 || values.tag !== 0x31) continue;
    const name = type.value.toString("utf8").toLowerCase();
    if (!ATTRIBUTE_RE.test(name)) continue;
    const raw: Buffer[] = [];
    let valueOffset = 0;
    while (valueOffset < values.value.length) {
      const item = readTlv(values.value, valueOffset); valueOffset = item.end;
      if (item.tag === 0x04) raw.push(Buffer.from(item.value));
    }
    rawAttributes[name] = raw;
    attributes[name] = raw.map((item) => item.toString("utf8"));
  }
  return { dn: dn.value.toString("utf8"), attributes, rawAttributes };
}

function ldapResult(value: Buffer) {
  let offset = 0;
  const code = readTlv(value, offset); offset = code.end;
  const matched = readTlv(value, offset); offset = matched.end;
  const diagnostic = readTlv(value, offset);
  return {
    code: decodeInteger(code.value),
    matchedDn: matched.value.toString("utf8"),
    diagnostic: diagnostic.value.toString("utf8").slice(0, 1000),
  };
}
function protocolOperation(message: Buffer) {
  const outer = readTlv(message, 0);
  if (outer.tag !== 0x30) throw new LdapClientError("Message LDAP invalide.", "ldap_invalid_message");
  const id = readTlv(outer.value, 0);
  return readTlv(outer.value, id.end);
}
function messageIdentifier(message: Buffer) {
  const outer = readTlv(message, 0);
  if (outer.tag !== 0x30) return -1;
  const id = readTlv(outer.value, 0);
  return id.tag === 0x02 ? decodeInteger(id.value) : -1;
}
function completeFrameSize(buffer: Buffer): number | null {
  if (buffer.length < 2) return null;
  if (buffer[0] !== 0x30) throw new LdapClientError("Trame LDAP invalide.", "ldap_invalid_frame");
  const length = decodeLength(buffer, 1);
  if (!length) return null;
  const total = length.next + length.length;
  if (total > MAX_FRAME_BYTES) throw new LdapClientError("Trame LDAP trop volumineuse.", "ldap_response_too_large");
  return total;
}
function readTlv(buffer: Buffer, offset: number) {
  if (offset >= buffer.length) throw new LdapClientError("BER LDAP tronqué.", "ldap_invalid_ber");
  const tag = buffer[offset];
  const decoded = decodeLength(buffer, offset + 1);
  if (!decoded) throw new LdapClientError("BER LDAP tronqué.", "ldap_invalid_ber");
  const end = decoded.next + decoded.length;
  if (end > buffer.length) throw new LdapClientError("BER LDAP tronqué.", "ldap_invalid_ber");
  return { tag, value: buffer.subarray(decoded.next, end), end };
}
function decodeLength(buffer: Buffer, offset: number): { length: number; next: number } | null {
  if (offset >= buffer.length) return null;
  const firstByte = buffer[offset];
  if ((firstByte & 0x80) === 0) return { length: firstByte, next: offset + 1 };
  const count = firstByte & 0x7f;
  if (count < 1 || count > 4 || offset + 1 + count > buffer.length) return null;
  let length = 0;
  for (let index = 0; index < count; index += 1) length = length * 256 + buffer[offset + 1 + index];
  return { length, next: offset + 1 + count };
}
function ldapMessage(messageId: number, operation: Buffer) { return sequence(integer(messageId), operation); }
function application(number: number, content: Buffer) { return tlv(0x60 + number, content); }
function sequence(...items: Buffer[]) { return tlv(0x30, Buffer.concat(items)); }
function octet(value: string | Buffer) { return tlv(0x04, Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")); }
function enumeration(value: number) { return tlv(0x0a, encodePositiveInteger(value)); }
function integer(value: number) { return tlv(0x02, encodePositiveInteger(value)); }
function boolean(value: boolean) { return tlv(0x01, Buffer.from([value ? 0xff : 0x00])); }
function tlv(tag: number, content: Buffer) { return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]); }
function encodeLength(length: number) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) { bytes.unshift(remaining & 0xff); remaining = Math.floor(remaining / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function encodePositiveInteger(value: number) {
  if (!Number.isInteger(value) || value < 0) throw new LdapClientError("Entier BER invalide.", "ldap_invalid_ber");
  const bytes: number[] = [];
  let remaining = value;
  do { bytes.unshift(remaining & 0xff); remaining = Math.floor(remaining / 256); } while (remaining > 0);
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0);
  return Buffer.from(bytes);
}
function decodeInteger(value: Buffer) {
  let result = 0;
  for (const byte of value) result = result * 256 + byte;
  return result;
}
function activeDirectoryGuid(value: Buffer) {
  const data1 = value.subarray(0, 4).reverse().toString("hex");
  const data2 = value.subarray(4, 6).reverse().toString("hex");
  const data3 = value.subarray(6, 8).reverse().toString("hex");
  const data4 = value.subarray(8, 10).toString("hex");
  const data5 = value.subarray(10, 16).toString("hex");
  return `${data1}-${data2}-${data3}-${data4}-${data5}`;
}
function first(values: string[] | undefined) { return values?.find((value) => value.length > 0) ?? ""; }
function boundedInteger(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function requiredDn(value: unknown, message: string) { const dn = optionalDn(value); if (!dn) throw new LdapClientError(message, "ldap_invalid_configuration"); return dn; }
function optionalDn(value: unknown) { if (value === undefined || value === null || value === "") return null; const dn = String(value).trim(); return dn && dn.length <= 2048 && !/[\r\n\0]/.test(dn) ? dn : null; }
function ldapToken(value: unknown, fallback: string) { const token = String(value ?? fallback).trim(); if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(token)) throw new LdapClientError("Classe d'objet LDAP invalide.", "ldap_invalid_configuration"); return token; }
function isValidHost(value: string) { return Boolean(value && value.length <= 253 && (net.isIP(value) || value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))); }

export class LdapClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly ldapResultCode?: number;
  constructor(message: string, code: string, retryable = false, ldapResultCode?: number) {
    super(message);
    this.name = "LdapClientError";
    this.code = code;
    this.retryable = retryable;
    this.ldapResultCode = ldapResultCode;
  }
}
