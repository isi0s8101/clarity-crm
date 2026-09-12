"use client";

import Link from "next/link";
import type { HelpProcedure } from "@/lib/help/types";

export function HelpProcedureCard({ procedure, compact = false, onSelect }: { procedure: HelpProcedure; compact?: boolean; onSelect?: (procedure: HelpProcedure) => void }) {
  const content = (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-300 hover:shadow-md">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">{procedure.id}</code>
        <span className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">v{procedure.version}</span>
        {procedure.roles.includes("admin") ? <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">admin</span> : null}
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-950">{procedure.title}</h3>
      {!compact ? <p className="mt-1 text-sm text-slate-600">{procedure.description}</p> : null}
      <p className="mt-3 text-xs text-slate-500">{procedure.steps.length} étape(s) · {procedure.contexts.slice(0, 3).join(", ")}</p>
    </article>
  );

  if (onSelect) {
    return <button type="button" className="block w-full text-left" onClick={() => onSelect(procedure)}>{content}</button>;
  }

  return <Link href={`/help/procedure/${procedure.id}`} className="block">{content}</Link>;
}