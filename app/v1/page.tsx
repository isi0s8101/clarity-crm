import { requireChatGPTUser } from "../chatgpt-auth";
import { LogoutButton } from "../logout-button";
import { TenantSwitcher } from "../tenant-switcher";
import { V1Console } from "./v1-console";

export const dynamic = "force-dynamic";

export default async function V1Page() {
  const user = await requireChatGPTUser("/v1");
  return (
    <>
      <V1Console user={{ email: user.email, displayName: user.displayName }} />
      <TenantSwitcher />
      <LogoutButton />
    </>
  );
}
