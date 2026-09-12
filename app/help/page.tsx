import Link from "next/link";

import { HelpHome } from "@/components/help/help-home";
import { helpCatalog } from "@/lib/help/catalog.js";
import type { HelpProcedure } from "@/lib/help/types";
import { getHelpContext } from "./help-page-utils";

export const dynamic = "force-dynamic";

export default async function HelpPage() {
  const context = await getHelpContext("dashboard");
  return (
    <main className="min-h-screen bg-slate-50 px-5 py-6 text-slate-950 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-blue-700">Documentation officielle</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Centre d&apos;aide Clarity CRM</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">Une aide contextuelle, filtrée par rôle, permissions et tenant courant.</p>
          </div>
          <Link href="/" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">Retour au CRM</Link>
        </header>
        <HelpHome context={context} catalog={helpCatalog as HelpProcedure[]} />
      </div>
    </main>
  );
}