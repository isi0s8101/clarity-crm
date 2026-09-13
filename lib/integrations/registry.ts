import type { Connector } from "@/lib/integrations/connector";
import { googleConnector, googleScopesForCapabilities } from "@/lib/integrations/providers/google";
import { ldapConnector } from "@/lib/integrations/providers/ldap";
import { microsoftConnector, microsoftScopesForCapabilities } from "@/lib/integrations/providers/microsoft";
import { n8nConnector } from "@/lib/integrations/providers/n8n";

const connectors = new Map<string, Connector>([
  [googleConnector.metadata().provider, googleConnector],
  [microsoftConnector.metadata().provider, microsoftConnector],
  [n8nConnector.metadata().provider, n8nConnector],
  [ldapConnector.metadata().provider, ldapConnector],
]);

const scopeResolvers = new Map<string, (capabilities: string[]) => string[]>([
  ["google", googleScopesForCapabilities],
  ["microsoft", microsoftScopesForCapabilities],
]);

export function getIntegrationConnector(provider: string) {
  const connector = connectors.get(normalizeProvider(provider));
  if (!connector) throw new UnsupportedIntegrationProviderError(provider);
  return connector;
}

export function listIntegrationConnectors() {
  return [...connectors.values()].map((connector) => ({
    ...connector.metadata(),
    capabilities: [...connector.capabilities()],
  }));
}

export function suggestedIntegrationScopes(provider: string, capabilities: string[]) {
  const connector = getIntegrationConnector(provider);
  validateCapabilities(connector, capabilities);
  return scopeResolvers.get(connector.metadata().provider)?.(capabilities) ?? [];
}

export function validateCapabilities(connector: Connector, capabilities: string[]) {
  const supported = new Set<string>(connector.capabilities());
  for (const capability of capabilities) {
    if (!supported.has(capability)) {
      throw new Error(`Capacité non prise en charge par ${connector.metadata().provider}: ${capability}`);
    }
  }
}

function normalizeProvider(value: string) {
  return String(value ?? "").trim().toLowerCase();
}

export class UnsupportedIntegrationProviderError extends Error {
  readonly status = 400;
  constructor(provider: string) {
    super(`Fournisseur d'intégration non pris en charge: ${String(provider || "(vide)")}.`);
    this.name = "UnsupportedIntegrationProviderError";
  }
}
