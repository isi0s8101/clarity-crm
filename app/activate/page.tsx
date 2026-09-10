import { Suspense } from "react";

import { ActivationForm } from "./activation-form";

export const dynamic = "force-dynamic";

export default function ActivatePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <Suspense fallback={<div className="text-sm text-slate-500">Chargement…</div>}>
        <ActivationForm />
      </Suspense>
    </main>
  );
}
