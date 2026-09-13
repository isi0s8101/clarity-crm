import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { resolveAuthContext } from "@/lib/authz";
import { requireChatGPTUser } from "./chatgpt-auth";
import { LogoutButton } from "./logout-button";
import { TenantSwitcher } from "./tenant-switcher";
import { V1Console } from "./v1/v1-console";
import { V12ConfigurationHistory } from "./v1/v12-config-history";
import { V12Workspace } from "./v1/v12-workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  const headerList = await headers();
  const actor = await resolveAuthContext({ headers: new Headers(headerList) });
  if (actor.role === "client") redirect("/portal");
  return (
    <>
      <V1Console user={{ email: user.email, displayName: user.displayName }} />
      <V12Workspace />
      {actor.role === "admin" ? <V12ConfigurationHistory /> : null}
      <TenantSwitcher />
      <LogoutButton />
    </>
  );
}