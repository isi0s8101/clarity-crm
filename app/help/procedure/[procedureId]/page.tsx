import Link from "next/link";
import { notFound } from "next/navigation";

import { HelpPrerequisites } from "@/components/help/help-prerequisites";
import { HelpWizard } from "@/components/help/help-wizard";
import { helpCatalog } from "@/lib/help/catalog.js";
import { getProcedure, procedureVisibleForContext } from "@/lib/help/resolver.js";
import type { HelpProcedure } from "@/lib/help/types";
import { getHelpContext } from "../../help-page-utils";

export { dynamic } from "../../help-page-utils";

export default async function HelpProcedurePage({ params }: { params: Promise<{ procedureId: string }> | { procedureId: string } }) {
  const resolved = await Promise.resolve(params);
  const procedure = getProcedure(resolved.procedureId, helpCatalog) as HelpProcedure | null;
  if (!procedure) notFound();
  const context = await getHelpContext(procedure.contexts[0] ?? "dashboard");
  const visible = procedureVisibleForContext(procedure, context);

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-6 text-slate-950 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <code className="rounded bg-slate-200 px-2 py-1 text-xs">{procedure.id} · v{procedure.version}</code>
            <h1 className="mt-3 text-2xl font-semibold">{procedure.title}</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">{procedure.description}</p>
          </div>
          <Link href="/help" className="rounded-lg border bg-white px-3 py-2 text-sm">Centre d&apos;aide</Link>
        </header>
        {visible ? (
          <>
            <HelpPrerequisites procedure={procedure} catalog={helpCatalog as HelpProcedure[]} returnTo={procedure.id} />
            <HelpWizard procedure={procedure} />
            {procedure.troubleshooting?.length ? <section className="rounded-lg border border-slate-200 bg-white p-4"><h2 className="font-semibold">Dépannage lié</h2><div className="mt-3 space-y-2">{procedure.troubleshooting.map((item) => <p className="text-sm text-slate-600" key={`${item.condition}-${item.procedureId}`}><strong>{item.condition} :</strong> {item.message} {item.procedureId ? <Link className="text-blue-700" href={`/help/procedure/${item.procedureId}`}>{item.procedureId}</Link> : null}</p>)}</div></section> : null}
          </>
        ) : (
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">Cette procédure existe, mais elle n&apos;est pas proposée comme action réalisable avec votre rôle ou vos permissions actuelles.</section>
        )}
      </div>
    </main>
  );
}