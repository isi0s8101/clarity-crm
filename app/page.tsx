import { requireChatGPTUser } from "./chatgpt-auth";
import { CRMShell } from "./crm-shell";
import { LogoutButton } from "./logout-button";
import { TenantSwitcher } from "./tenant-switcher";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return (
    <>
      <CRMShell user={{ email: user.email, displayName: user.displayName }} />
      <TenantSwitcher />
      <LogoutButton />
    </>
  );
}
