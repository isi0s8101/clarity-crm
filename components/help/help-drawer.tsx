"use client";

import { useEffect, useMemo, useState } from "react";
import type { HelpContext, HelpProcedure } from "@/lib/help/types";
import { helpCatalog } from "@/lib/help/catalog.js";
import { HelpContextRecommendations } from "./help-context-recommendations";
import { HelpSearch } from "./help-search";
import { HelpWizard } from "./help-wizard";

type HelpContextResponse = {
  context: HelpContext;
  recommendations: HelpProcedure[];
};

export function HelpDrawer({ open, onOpenChange, view, recordType, action }: { open: boolean; onOpenChange: (open: boolean) => void; view: string; recordType?: string; action?: string }) {
  const [serverContext, setServerContext] = useState<HelpContext | null>(null);
  const [selected, setSelected] = useState<HelpProcedure | null>(null);

  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams({ view });
    if (recordType) params.set("recordType", recordType);
    if (action) params.set("action", action);
    fetch(`/api/help/context?${params.toString()}`)
      .then(async (response): Promise<HelpContextResponse | null> => response.ok ? response.json() as Promise<HelpContextResponse> : null)
      .then((payload) => {
        if (payload?.context) setServerContext(payload.context);
      })
      .catch(() => undefined);
  }, [action, open, recordType, view]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange, open]);

  const context = useMemo<HelpContext>(() => serverContext ?? { view, role: "user", permissions: [] }, [serverContext, view]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Aide Clarity CRM">
      <button type="button" aria-label="Fermer l'aide" className="absolute inset-0 bg-slate-950/30" onClick={() => onOpenChange(false)} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col overflow-auto bg-slate-50 p-4 shadow-2xl md:rounded-l-xl">
        <header className="sticky top-0 z-10 -mx-4 -mt-4 mb-4 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Aide contextuelle</p><h2 className="font-semibold text-slate-950">Vous êtes dans : {context.view}</h2></div>
            <button type="button" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={() => onOpenChange(false)}>Fermer</button>
          </div>
        </header>
        <div className="space-y-4">
          {selected ? (
            <>
              <button type="button" className="text-sm text-blue-700" onClick={() => setSelected(null)}>Retour aux recommandations</button>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <code className="text-xs text-slate-500">{selected.id}</code>
                <h3 className="mt-2 text-lg font-semibold">{selected.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{selected.description}</p>
              </div>
              <HelpWizard procedure={selected} />
            </>
          ) : (
            <>
              <HelpContextRecommendations context={context} catalog={helpCatalog as HelpProcedure[]} onSelect={setSelected} />
              <HelpSearch context={context} catalog={helpCatalog as HelpProcedure[]} onSelect={setSelected} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}