"use client";

export function HelpProgress({ current, total, completed }: { current: number; total: number; completed?: boolean }) {
  const percent = completed ? 100 : total ? Math.round(((current + 1) / total) * 100) : 0;
  return (
    <div aria-label={`Progression ${percent}%`} className="space-y-2">
      <div className="flex justify-between text-xs text-slate-500">
        <span>Étape {Math.min(current + 1, total)} sur {total}</span>
        <span>{completed ? "Terminé" : `${percent}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-blue-600" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}