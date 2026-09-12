"use client";

import type { HelpContext, HelpProcedure } from "@/lib/help/types";
import { recommendProcedures } from "@/lib/help/resolver.js";
import { HelpProcedureCard } from "./help-procedure-card";

export function HelpContextRecommendations({ context, catalog, onSelect }: { context: HelpContext; catalog: HelpProcedure[]; onSelect?: (procedure: HelpProcedure) => void }) {
  const recommendations = recommendProcedures(context, 4, catalog) as HelpProcedure[];
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold text-slate-950">Que souhaitez-vous faire ?</h2>
      <p className="mt-1 text-sm text-slate-500">Vous êtes dans : {context.view ?? "Clarity CRM"}</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {recommendations.length ? recommendations.map((procedure) => <HelpProcedureCard key={procedure.id} procedure={procedure} compact onSelect={onSelect} />) : <p className="text-sm text-slate-500">Aucune recommandation directe avec vos permissions actuelles.</p>}
      </div>
    </section>
  );
}