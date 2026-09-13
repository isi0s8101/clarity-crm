import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { LogoutButton } from "@/app/logout-button";
import { TenantSwitcher } from "@/app/tenant-switcher";
import { PortalClient } from "./portal-client";

export const dynamic = "force-dynamic";

export default async function PortalPage() {
  await requireChatGPTUser("/portal");
  return (
    <>
      <PortalClient />
      <TenantSwitcher />
      <LogoutButton />
    </>
  );
}
