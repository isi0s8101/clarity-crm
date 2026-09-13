import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { LogoutButton } from "@/app/logout-button";
import { TenantSwitcher } from "@/app/tenant-switcher";
import { resolveAuthContext } from "@/lib/authz";
import { PortalClient } from "./portal-client";

export const dynamic = "force-dynamic";

export default async function PortalPage() {
  await requireChatGPTUser("/portal");
  const headerList = await headers();
  const actor = await resolveAuthContext({ headers: new Headers(headerList) });
  if (actor.role !== "client") redirect("/");
  return (
    <>
      <PortalClient />
      <TenantSwitcher />
      <LogoutButton />
    </>
  );
}