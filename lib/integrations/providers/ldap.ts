import {
  ConnectorError,
  type Connector,
  type ConnectorHealth,
  type IntegrationCapability,
  type PullItem,
  type PullPage,
} from "@/lib/integrations/connector";
import {
  LdapClientError,
  ldapEntryExternalId,
  ldapEntryVersion,
  normalizeLdapConfig,
  searchLdapDirectory,
  testLdapBind,
  type LdapEntry,
} from "@/lib/integrations/ldap-client";

const CAPABILITIES: readonly IntegrationCapability[] = ["directory.users.read", "directory.groups.read"];

export const ldapConnector: Connector = {
  metadata() {
    return {
      provider: "ldap",
      label: "LDAP / Active Directory",
      category: "directory",
      authorization: "credentials",
    };
  },
  capabilities() {
    return CAPABILITIES;
  },
  validateConfiguration(configuration) {
    normalizeLdapConfig(configuration);
  },
  async testConnection(context) {
    const started = Date.now();
    const password = await context.getSecret("bind_password");
    if (!password) return authHealth("ldap_bind_password_missing", "Mot de passe bind LDAP absent.");
    try {
      await testLdapBind(normalizeLdapConfig(context.connection.configuration), password);
      return {
        ok: true,
        status: "healthy",
        code: "ok",
        message: "Connexion LDAPS et bind opérationnels.",
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const normalized = normalizeLdapError(error);
      if (normalized.authRequired) return authHealth(normalized.code, normalized.message, Date.now() - started);
      return {
        ok: false,
        status: normalized.retryable ? "degraded" : "failed",
        code: normalized.code,
        message: normalized.message,
        latencyMs: Date.now() - started,
      };
    }
  },
  async pull(context, resourceType) {
    const password = await context.getSecret("bind_password");
    if (!password) throw new ConnectorError("Mot de passe bind LDAP absent.", { code: "ldap_bind_password_missing", authRequired: true });
    const config = normalizeLdapConfig(context.connection.configuration);
    if (resourceType === "directory.users") {
      requireCapability(context.connection.capabilities, "directory.users.read");
      const entries = await searchLdapDirectory(config, password, "users");
      return fullPage(entries.map(userItem).filter((item): item is PullItem => Boolean(item)));
    }
    if (resourceType === "directory.groups") {
      requireCapability(context.connection.capabilities, "directory.groups.read");
      const entries = await searchLdapDirectory(config, password, "groups");
      return fullPage(entries.map(groupItem).filter((item): item is PullItem => Boolean(item)));
    }
    throw new ConnectorError(`Ressource LDAP non prise en charge: ${resourceType}.`, { code: "ldap_resource_unsupported" });
  },
  normalizeError(error) {
    return normalizeLdapError(error);
  },
};

function userItem(entry: LdapEntry): PullItem | null {
  const externalId = ldapEntryExternalId(entry);
  if (!externalId) return null;
  const displayName = first(entry, "displayname") || first(entry, "cn") || first(entry, "samaccountname") || first(entry, "uid") || "Utilisateur annuaire";
  return {
    externalId,
    externalVersion: ldapEntryVersion(entry),
    data: {
      kind: "contact",
      provider: "ldap",
      title: displayName.slice(0, 160),
      email: (first(entry, "mail") || first(entry, "userprincipalname")).toLowerCase().slice(0, 254),
      phone: (first(entry, "telephonenumber") || first(entry, "mobile")).slice(0, 120),
      organization: (first(entry, "company") || first(entry, "department")).slice(0, 240),
      jobTitle: first(entry, "title").slice(0, 240),
      directoryDn: entry.dn.slice(0, 2048),
      directoryUsername: (first(entry, "samaccountname") || first(entry, "uid") || first(entry, "userprincipalname")).slice(0, 256),
    },
  };
}

function groupItem(entry: LdapEntry): PullItem | null {
  const externalId = ldapEntryExternalId(entry);
  if (!externalId) return null;
  const members = values(entry, "member").slice(0, 500).map((value) => value.slice(0, 2048));
  return {
    externalId,
    externalVersion: ldapEntryVersion(entry),
    data: {
      kind: "directory_group",
      provider: "ldap",
      title: (first(entry, "cn") || "Groupe annuaire").slice(0, 160),
      email: first(entry, "mail").toLowerCase().slice(0, 254),
      directoryDn: entry.dn.slice(0, 2048),
      memberCount: values(entry, "member").length,
      members,
    },
  };
}

function fullPage(items: PullItem[]): PullPage {
  return { items, hasMore: false };
}
function requireCapability(capabilities: string[], capability: IntegrationCapability) {
  if (!capabilities.includes(capability)) throw new ConnectorError(`Capacité LDAP non activée: ${capability}.`, { code: "ldap_capability_not_enabled" });
}
function first(entry: LdapEntry, attribute: string) { return values(entry, attribute).find((value) => value.length > 0) ?? ""; }
function values(entry: LdapEntry, attribute: string) { return entry.attributes[attribute.toLowerCase()] ?? []; }
function authHealth(code: string, message: string, latencyMs?: number): ConnectorHealth { return { ok: false, status: "authentication_required", code, message, latencyMs }; }
function normalizeLdapError(error: unknown) {
  if (error instanceof ConnectorError) return error;
  if (error instanceof LdapClientError) {
    const authRequired = error.code === "ldap_bind_failed" || error.code === "ldap_bind_password_invalid";
    return new ConnectorError(error.message, { code: error.code, retryable: error.retryable, authRequired });
  }
  return new ConnectorError(error instanceof Error ? error.message : "Erreur LDAP inconnue.", { code: "ldap_error", retryable: true });
}
