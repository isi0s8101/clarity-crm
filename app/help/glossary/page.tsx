import Link from "next/link";

import { glossary } from "@/lib/help/glossary.js";

export const dynamic = "force-dynamic";

export default function HelpGlossaryPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-5 py-6 text-slate-950 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Glossaire Clarity CRM</h1><p className="mt-1 text-sm text-slate-600">Termes utilisés dans l&apos;application et dans l&apos;aide.</p></div><Link href="/help" className="rounded-lg border bg-white px-3 py-2 text-sm">Centre d&apos;aide</Link></header>
        <dl className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {glossary.map((item) => <div className="grid gap-2 p-4 md:grid-cols-[180px_1fr]" key={item.term}><dt className="font-semibold text-slate-950">{item.term}</dt><dd className="text-sm leading-6 text-slate-600">{item.definition}</dd></div>)}
        </dl>
      </div>
    </main>
  );
}