"use client";

import Link from "next/link";
import { useState } from "react";
import type { HelpContext, HelpProcedure } from "@/lib/help/types";
import { filterProcedures, recommendProcedures } from "@/lib/help/resolver.js";
import { HelpSearch } from "./help-search";
import { HelpProcedureCard } from "./help-procedure-card";

export function HelpHome({ context, catalog }: { context: HelpContext; catalog: HelpProcedure[] }) {
  const [recent] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem("clarity.help.recent");
      return raw ? JSON.parse(raw) as string[] : [];
    } catch {
      return [];
    }
  });
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const recommendations = recommendProcedures(context, 4, catalog) as HelpProcedure[];
  const userItems = filterProcedures({ ...context, view: "crm" }, catalog).filter((item: HelpProcedure) => item.roles.includes("user")).slice(0, 8) as HelpProcedure[];
  const adminItems = context.role === "admin" ? filterProcedures({ ...context, view: "config" }, catalog).filter((item: HelpProcedure) => item.roles.includes("admin")).slice(0, 8) as HelpProcedure[] : [];
  const recentItems = recent.map((id) => byId.get(id)).filter(Boolean) as HelpProcedure[];

  return (
    <div className="space-y-5">
      <HelpSearch context={context} catalog={catalog} />
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-950">Procédures recommandées</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {recommendations.map((procedure) => <HelpProcedureCard key={procedure.id} procedure={procedure} />)}
        </div>
      </section>
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Utilisateur</h2><Link className="text-sm text-blue-700" href="/help/user">Tout voir</Link></div>
          <div className="mt-4 space-y-3">{userItems.map((procedure) => <HelpProcedureCard key={procedure.id} procedure={procedure} compact />)}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Administrateur</h2>{context.role === "admin" ? <Link className="text-sm text-blue-700" href="/help/admin">Tout voir</Link> : null}</div>
          {context.role === "admin" ? <div className="mt-4 space-y-3">{adminItems.map((procedure) => <HelpProcedureCard key={procedure.id} procedure={procedure} compact />)}</div> : <p className="mt-4 text-sm text-slate-500">Les procédures administrateur ne sont visibles que pour un rôle admin réel.</p>}
        </div>
      </section>
      <section className="grid gap-5 lg:grid-cols-3">
        <Link href="/help/troubleshooting" className="rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300"><h2 className="font-semibold">Dépannage</h2><p className="mt-1 text-sm text-slate-500">Accès refusé, fiche introuvable, import ou webhook en échec.</p></Link>
        <Link href="/help/glossary" className="rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300"><h2 className="font-semibold">Glossaire</h2><p className="mt-1 text-sm text-slate-500">Tenant, rôle, permission, scope, timeline, audit.</p></Link>
        <div className="rounded-lg border border-slate-200 bg-white p-4"><h2 className="font-semibold">Récemment consultées</h2><div className="mt-3 space-y-2">{recentItems.length ? recentItems.map((procedure) => <Link key={procedure.id} className="block text-sm text-blue-700" href={`/help/procedure/${procedure.id}`}>{procedure.id} — {procedure.title}</Link>) : <p className="text-sm text-slate-500">Aucune procédure récente.</p>}</div></div>
      </section>
    </div>
  );
}