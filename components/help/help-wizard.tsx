"use client";

import { useEffect, useState } from "react";
import type { HelpProcedure } from "@/lib/help/types";
import { readProgress, resetProgress, writeProgress } from "@/lib/help/progress.js";
import { HelpProgress } from "./help-progress";

export function HelpWizard({ procedure }: { procedure: HelpProcedure }) {
  const [progress, setProgress] = useState(() => {
    if (typeof window === "undefined") return { version: procedure.version, step: 0, completed: false };
    return readProgress(window.localStorage, procedure);
  });
  const step = procedure.steps[progress.step] ?? procedure.steps[0];

  useEffect(() => {
    const raw = window.localStorage.getItem("clarity.help.recent");
    let current: string[] = [];
    try {
      current = raw ? JSON.parse(raw) as string[] : [];
    } catch {
      current = [];
    }
    window.localStorage.setItem("clarity.help.recent", JSON.stringify([procedure.id, ...current.filter((id) => id !== procedure.id)].slice(0, 8)));
    const timer = window.setTimeout(() => setProgress(readProgress(window.localStorage, procedure)), 0);
    return () => window.clearTimeout(timer);
  }, [procedure]);

  const persist = (next: typeof progress) => setProgress(writeProgress(window.localStorage, procedure, next));
  const previous = () => persist({ ...progress, step: Math.max(0, progress.step - 1), completed: false });
  const next = () => {
    if (progress.step >= procedure.steps.length - 1) persist({ ...progress, completed: true });
    else persist({ ...progress, step: progress.step + 1, completed: false });
  };
  const reset = () => {
    resetProgress(window.localStorage, procedure.id);
    setProgress({ version: procedure.version, step: 0, completed: false });
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <HelpProgress current={progress.step} total={procedure.steps.length} completed={progress.completed} />
      <div className="mt-5 grid gap-5 md:grid-cols-[220px_1fr]">
        <ol className="space-y-2 text-sm">
          {procedure.steps.map((item, index) => (
            <li key={`${item.title}-${index}`} className={`flex gap-2 rounded-lg px-2 py-1 ${index === progress.step ? "bg-blue-50 text-blue-800" : index < progress.step || progress.completed ? "text-emerald-700" : "text-slate-500"}`}>
              <span>{index < progress.step || progress.completed ? "✓" : index === progress.step ? "●" : "○"}</span>
              <span className="line-clamp-2">{item.title}</span>
            </li>
          ))}
        </ol>
        <article className="min-w-0 rounded-lg border border-slate-200 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">{procedure.id}</p>
          <h2 className="mt-2 text-lg font-semibold text-slate-950">{progress.completed ? "Procédure terminée" : step.title}</h2>
          <p className="mt-3 text-sm leading-6 text-slate-700">{progress.completed ? procedure.result : step.instruction}</p>
          {!progress.completed && step.expected ? <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600"><strong>Résultat attendu :</strong> {step.expected}</p> : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={previous} disabled={progress.step === 0 || progress.completed} className="rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:opacity-50">Précédent</button>
            <button type="button" onClick={next} disabled={progress.completed} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{progress.step >= procedure.steps.length - 1 ? "Terminer" : "Suivant"}</button>
            <button type="button" onClick={reset} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Réinitialiser</button>
          </div>
        </article>
      </div>
    </section>
  );
}