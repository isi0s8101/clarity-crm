export function resolveAccessSelection({
  tenantSelector,
  memberships,
  pendingInvitations,
  totalMembershipCount,
}) {
  if (tenantSelector) {
    const membership = memberships.find((item) => item.tenantId === tenantSelector) ?? null;
    const invitation = pendingInvitations.find((item) => item.tenantId === tenantSelector) ?? null;
    if (membership) return { kind: "membership", membership };
    if (invitation) return { kind: "invitation", invitation };
    return { kind: "denied", reason: "tenant_access_denied" };
  }

  const activeMemberships = memberships.filter((item) => item.status === "active");
  if (activeMemberships.length === 1) {
    return { kind: "membership", membership: activeMemberships[0] };
  }
  if (activeMemberships.length > 1 || memberships.length > 1) {
    return { kind: "denied", reason: "tenant_selection_required" };
  }
  if (memberships.length === 1) {
    return { kind: "membership", membership: memberships[0] };
  }
  if (pendingInvitations.length === 1) {
    return { kind: "invitation", invitation: pendingInvitations[0] };
  }
  if (pendingInvitations.length > 1) {
    return { kind: "denied", reason: "tenant_selection_required" };
  }
  if (totalMembershipCount === 0) {
    return { kind: "bootstrap" };
  }
  return { kind: "denied", reason: "invitation_required" };
}
