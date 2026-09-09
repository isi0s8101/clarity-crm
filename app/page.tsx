import { CRMShell } from "./crm-shell";
import { requireChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <CRMShell user={{ email: user.email, displayName: user.displayName }} />;
}
