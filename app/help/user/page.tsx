import Link from "next/link";

import { HelpProcedureCard } from "@/components/help/help-procedure-card";
import { helpCatalog } from "@/lib/help/catalog.js";
import { filterProcedures } from "@/lib/help/resolver.js";
import type { HelpProcedure } from "@/lib/help/types";
import { getHelpContext } from "../help-page-utils";

export { dynamic } from "../help-page-utils";

export default async function HelpUserPage() {
  const context = await getHelpContext("crm");
  const procedures = filterProcedures(context, helpCatalog).filter((item: HelpProcedure) => item.roles.includes("user")) as HelpProcedure[];
  return (
    <main className="min-h-screen bg-slate-50 px-5 py-6 text-slate-950 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Aide utilisateur</h1><p className="mt-1 text-sm text-slate-600">Procédures visibles selon vos permissions réelles.</p></div><Link href="/help" className="rounded-lg border bg-white px-3 py-2 text-sm">Centre d&apos;aide</Link></header>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{procedures.map((procedure) => <HelpProcedureCard key={procedure.id} procedure={procedure} />)}</div>
      </div>
    </main>
  );
}