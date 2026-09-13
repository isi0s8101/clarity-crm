import type { AuthContext } from "@/lib/authz";
import {
  assertIntegrationMappingAllows,
  loadIntegrationMapping,
} from "@/lib/integration-mappings";
import { requestIntegrationSync } from "@/lib/integration-sync";

export async function requestMappedIntegrationSync(actor: AuthContext, input: {
  connectionId: string;
  resourceType: string;
  direction?: "pull" | "push";
  triggerKind?: "initial" | "manual" | "scheduled" | "retry" | "webhook";
}) {
  const direction = input.direction ?? "pull";
  const mapping = await loadIntegrationMapping(actor.tenantId, input.connectionId, input.resourceType);
  assertIntegrationMappingAllows(mapping, direction);
  return requestIntegrationSync(actor, { ...input, direction });
}
