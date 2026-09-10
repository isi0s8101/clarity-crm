import { Suspense } from "react";
import { redirect } from "next/navigation";

import { getChatGPTUser } from "../chatgpt-auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getChatGPTUser();
  if (user) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <Suspense fallback={<div className="text-sm text-slate-500">Chargement…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
