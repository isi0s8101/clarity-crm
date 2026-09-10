import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";

import { normalizeWebhookUrl } from "./crm-policy.js";

export class WebhookResponseTooLargeError extends Error {
  constructor(limitBytes) {
    super(`Réponse webhook trop volumineuse: limite ${limitBytes} octets.`);
    this.name = "WebhookResponseTooLargeError";
    this.limitBytes = limitBytes;
  }
}

export async function validateWebhookTargetUrl(value, options = {}) {
  const allowPrivate = options.allowPrivate === true;
  const normalized = normalizeWebhookUrl(value, { allowPrivate });
  if (!normalized) {
    return fail("URL webhook refusée : HTTPS public requis.");
  }

  const url = new URL(normalized);
  if (!hostMatchesAllowedWebhookHosts(url.hostname, options.allowedHosts)) {
    return fail("URL webhook refusée : hôte hors allowlist.");
  }

  if (allowPrivate) {
    return { ok: true, url: normalized, addresses: [] };
  }

  const resolveHost = typeof options.resolveHost === "function"
    ? options.resolveHost
    : resolveWebhookHost;
  let addresses;
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    return fail("URL webhook refusée : résolution DNS impossible.");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return fail("URL webhook refusée : résolution DNS impossible.");
  }

  for (const entry of addresses) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (!isPublicIpAddress(address)) {
      return fail("URL webhook refusée : adresse DNS privée, locale ou réservée.");
    }
  }

  return {
    ok: true,
    url: normalized,
    addresses: addresses.map((entry) => typeof entry === "string" ? entry : entry.address),
  };
}

export async function resolveWebhookHost(hostname) {
  const literal = stripHost(hostname);
  const ipVersion = net.isIP(literal);
  if (ipVersion) return [{ address: literal, family: ipVersion }];

  return dnsLookup(literal, { all: true, verbatim: true });
}

export function hostMatchesAllowedWebhookHosts(hostname, allowedHosts) {
  const host = stripHost(hostname);
  const allowlist = parseAllowedHostPolicy(allowedHosts);
  if (!allowlist.configured) return true;
  if (allowlist.patterns.length === 0) return false;

  return allowlist.patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

export function parseAllowedHosts(value) {
  return parseAllowedHostPolicy(value).patterns;
}

export function isPublicIpAddress(value) {
  if (typeof value !== "string") return false;
  const address = stripHost(value);
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) return isPublicIpv4(address);
  if (ipVersion === 6) return isPublicIpv6(address);
  return false;
}

export async function readLimitedResponseText(response, limitBytes = 4096) {
  const limit = normalizeLimit(limitBytes);
  if (!response.body || typeof response.body.getReader !== "function") {
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new WebhookResponseTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function dispatchWebhookRequest(target, options = {}) {
  if (!target?.ok) throw new Error("Cible webhook invalide.");
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const responseLimitBytes = normalizeLimit(options.responseLimitBytes);
  const request = {
    method: options.method ?? "POST",
    headers: options.headers ?? {},
    body: options.body ?? "",
  };

  if (!Array.isArray(target.addresses) || target.addresses.length === 0) {
    const response = await fetch(target.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      responseText: await readLimitedResponseText(response, responseLimitBytes),
    };
  }

  return dispatchPinnedHttpsRequest(target.url, target.addresses, request, {
    timeoutMs,
    responseLimitBytes,
  });
}

async function dispatchPinnedHttpsRequest(urlValue, addresses, request, limits) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:") {
    throw new Error("URL webhook refusée : HTTPS public requis.");
  }

  const address = selectPinnedAddress(addresses);
  if (!address) {
    throw new Error("URL webhook refusée : aucune adresse publique validée.");
  }

  const port = url.port ? Number(url.port) : 443;
  const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: request.method,
        host: address.address,
        port,
        path: `${url.pathname}${url.search}`,
        family: address.family,
        servername: url.hostname,
        headers: {
          ...request.headers,
          host: hostHeader,
        },
        timeout: limits.timeoutMs,
      },
      (res) => {
        readLimitedNodeStreamText(res, limits.responseLimitBytes)
          .then((responseText) => {
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              responseText,
            });
          })
          .catch((error) => {
            req.destroy(error);
            reject(error);
          });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("Timeout webhook dépassé."));
    });
    req.on("error", reject);
    req.end(request.body);
  });
}

function selectPinnedAddress(addresses) {
  for (const entry of addresses) {
    const address = typeof entry === "string" ? entry : entry?.address;
    const family = typeof entry === "string" ? net.isIP(entry) : entry?.family ?? net.isIP(address);
    if (isPublicIpAddress(address) && (family === 4 || family === 6)) {
      return { address, family };
    }
  }
  return null;
}

async function readLimitedNodeStreamText(stream, limitBytes) {
  const limit = normalizeLimit(limitBytes);
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) {
      stream.destroy?.(new WebhookResponseTooLargeError(limit));
      throw new WebhookResponseTooLargeError(limit);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total).toString("utf8");
}

function parseAllowedHostPolicy(value) {
  if (value === undefined || value === null) return { configured: false, patterns: [] };
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const normalized = raw
    .map((item) => stripHost(item))
    .filter((item) => item.length > 0);

  if (normalized.length === 0) return { configured: false, patterns: [] };

  return {
    configured: true,
    patterns: normalized.filter((item) => item === "*" || isAllowedHostPattern(item)).filter((item) => item !== "*"),
  };
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 5000;
  return Math.min(parsed, 30000);
}

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 4096;
  return Math.min(parsed, 65536);
}

function stripHost(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isAllowedHostPattern(value) {
  if (value.startsWith("*.")) return isDnsName(value.slice(2));
  if (net.isIP(value)) return true;
  return isDnsName(value);
}

function isDnsName(value) {
  if (value.length < 1 || value.length > 253) return false;
  return value
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isPublicIpv4(address) {
  const value = ipv4ToInt(address);
  if (value === null) return false;

  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];

  return !blocked.some(([range, prefix]) => ipv4InRange(value, range, prefix));
}

function ipv4ToInt(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    result = (result << 8) + value;
  }
  return result >>> 0;
}

function ipv4InRange(value, range, prefix) {
  const start = ipv4ToInt(range);
  if (start === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (start & mask);
}

function isPublicIpv6(address) {
  const parsed = parseIpv6(address);
  if (parsed === null) return false;

  const mappedIpv4 = ipv4FromMappedIpv6(parsed);
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);

  const blocked = [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ];

  if (blocked.some(([range, prefix]) => ipv6InRange(parsed, range, prefix))) {
    return false;
  }

  return ipv6InRange(parsed, "2000::", 3);
}

function parseIpv6(value) {
  let input = stripHost(value);
  const zoneIndex = input.indexOf("%");
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);

  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4 = input.slice(lastColon + 1);
    const ipv4Int = ipv4ToInt(ipv4);
    if (ipv4Int === null) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4Int >>> 16) & 0xffff).toString(16)}:${(ipv4Int & 0xffff).toString(16)}`;
  }

  const pieces = input.split("::");
  if (pieces.length > 2) return null;

  const head = pieces[0] ? pieces[0].split(":") : [];
  const tail = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  if (head.some((part) => !isHextet(part)) || tail.some((part) => !isHextet(part))) return null;

  const missing = 8 - head.length - tail.length;
  if (pieces.length === 1 && missing !== 0) return null;
  if (pieces.length === 2 && missing < 1) return null;

  const parts = [
    ...head,
    ...Array(Math.max(0, missing)).fill("0"),
    ...tail,
  ].map((part) => Number.parseInt(part, 16));

  if (parts.length !== 8 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;

  return parts.reduce((result, part) => (result << 16n) + BigInt(part), 0n);
}

function isHextet(value) {
  return /^[0-9a-f]{1,4}$/i.test(value);
}

function ipv6InRange(value, range, prefix) {
  const start = parseIpv6(range);
  if (start === null) return false;
  const bits = 128n;
  const prefixBits = BigInt(prefix);
  const mask = prefixBits === 0n ? 0n : ((1n << prefixBits) - 1n) << (bits - prefixBits);
  return (value & mask) === (start & mask);
}

function ipv4FromMappedIpv6(value) {
  const mappedPrefix = parseIpv6("::ffff:0:0");
  if (mappedPrefix === null) return null;
  const mask = ((1n << 96n) - 1n) << 32n;
  if ((value & mask) !== mappedPrefix) return null;
  const ipv4 = Number(value & 0xffffffffn);
  return [
    (ipv4 >>> 24) & 255,
    (ipv4 >>> 16) & 255,
    (ipv4 >>> 8) & 255,
    ipv4 & 255,
  ].join(".");
}

function fail(error) {
  return { ok: false, error };
}
