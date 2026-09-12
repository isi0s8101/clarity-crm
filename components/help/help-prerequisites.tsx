"use client";

import Link from "next/link";
import type { HelpProcedure } from "@/lib/help/types";

export function HelpPrerequisites({ procedure, catalog, returnTo }: { procedure: HelpProcedure; catalog: HelpProcedure[]; returnTo?: string }) {
  if (!procedure.prerequisites.length) return null;
  const byId = new Map(catalog.map((item) => [item.id, item]));
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold text-slate-950">Avant de commencer</h2>
      <div className="mt-3 space-y-2">
        {procedure.prerequisites.map((id) => {
          const item = byId.get(id);
          const href = `/help/procedure/${id}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;
          return (
            <Link key={id} href={href} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
              <span aria-hidden="true">○</span>
              <span><strong>{id}</strong>{item ? ` — ${item.title}` : ""}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}