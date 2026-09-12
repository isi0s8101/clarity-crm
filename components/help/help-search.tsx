"use client";

import { useMemo, useState } from "react";
import type { HelpContext, HelpProcedure } from "@/lib/help/types";
import { searchHelp } from "@/lib/help/search.js";
import { HelpProcedureCard } from "./help-procedure-card";

export function HelpSearch({ context, catalog, onSelect }: { context: HelpContext; catalog: HelpProcedure[]; onSelect?: (procedure: HelpProcedure) => void }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchHelp(query, context, catalog).slice(0, 12) as HelpProcedure[], [catalog, context, query]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <label className="text-sm font-medium text-slate-900" htmlFor="help-search">Recherche instantanée</label>
      <input
        id="help-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        placeholder="Ex. invitation, import, contact, permission..."
      />
      {query.trim() ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {results.length ? results.map((procedure) => <HelpProcedureCard key={procedure.id} procedure={procedure} compact onSelect={onSelect} />) : <p className="text-sm text-slate-500">Aucune procédure accessible ne correspond à cette recherche.</p>}
        </div>
      ) : null}
    </section>
  );
}