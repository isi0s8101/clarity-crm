"use client";

import { useEffect, useState } from "react";
import { Building2, CirclePlus, Database, LayoutDashboard, Search, Workflow } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";

export type CrmCommandView = "dashboard" | "pipeline" | "objects" | "automations" | "rights" | "modules" | "data" | "audit";

type SearchItem = { id: string; type: string; title: string; status: string; updatedAt: string };

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: CrmCommandView) => void;
  onCreateOpportunity: () => void;
  canAdminister: boolean;
};

const labelByType: Record<string, string> = {
  company: "Entreprise", contact: "Contact", lead: "Lead", opportunity: "Opportunité", task: "Tâche", note: "Note",
};

function groupByType(items: SearchItem[]) {
  return items.reduce<Record<string, SearchItem[]>>((groups, item) => {
    const type = labelByType[item.type] ?? "Objet CRM";
    groups[type] ??= [];
    groups[type].push(item);
    return groups;
  }, {});
}

export function CommandPalette({ open, onOpenChange, onNavigate, onCreateOpportunity, canAdminister }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/crm/search?q=${encodeURIComponent(query.trim())}&limit=30`, { signal: controller.signal });
        const payload = (await response.json().catch(() => null)) as { items?: SearchItem[] } | null;
        setItems(response.ok && Array.isArray(payload?.items) ? payload.items : []);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query]);

  const closeAndNavigate = (view: CrmCommandView) => { onNavigate(view); onOpenChange(false); };
  const shouldSearch = open && query.trim().length >= 2;
  const grouped = groupByType(shouldSearch ? items : []);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Recherche et commandes Clarity" description="Rechercher, naviguer ou créer" className="max-w-xl">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Rechercher une commande ou un élément…" />
      <CommandList>
        <CommandEmpty>{loading && shouldSearch ? "Recherche en cours…" : query.trim().length >= 2 ? "Aucun résultat accessible." : "Saisissez au moins deux caractères."}</CommandEmpty>
        {!query && <>
          <CommandGroup heading="Actions rapides">
            <CommandItem onSelect={() => { onCreateOpportunity(); onOpenChange(false); }}><CirclePlus />Créer une opportunité</CommandItem>
            <CommandItem onSelect={() => closeAndNavigate("pipeline")}><Workflow />Ouvrir le pipeline</CommandItem>
            <CommandItem onSelect={() => closeAndNavigate("dashboard")}><LayoutDashboard />Ouvrir l’accueil</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Navigation">
            <CommandItem onSelect={() => closeAndNavigate("objects")}><Database />Objets métier</CommandItem>
            {canAdminister && <CommandItem onSelect={() => closeAndNavigate("rights")}><Building2 />Droits et équipes</CommandItem>}
          </CommandGroup>
        </>}
        {Object.entries(grouped).map(([type, results]) => <CommandGroup heading={type} key={type}>
          {results.map((item) => <CommandItem key={`${item.type}-${item.id}`} value={`${type} ${item.title} ${item.status}`} onSelect={() => closeAndNavigate("objects")}>
            <Search /><span className="min-w-0 flex-1"><span className="block truncate">{item.title}</span><span className="block truncate text-xs text-muted-foreground">{item.status || type}</span></span><CommandShortcut>{type}</CommandShortcut>
          </CommandItem>)}
        </CommandGroup>)}
      </CommandList>
    </CommandDialog>
  );
}
