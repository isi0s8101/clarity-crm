"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Boxes,
  Building2,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Circle,
  Columns3,
  Database,
  Download,
  Filter,
  History,
  Key,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  Upload,
  Users,
  Wand2,
  Workflow,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";

type View =
  | "dashboard"
  | "pipeline"
  | "objects"
  | "automations"
  | "rights"
  | "modules"
  | "data"
  | "audit";

type Stage = "qualification" | "decouverte" | "proposition" | "negociation" | "gagne";

type Deal = {
  id: string;
  name: string;
  company: string;
  amount: number;
  stage: Stage;
  owner: string;
  due: string;
  confidence: number;
  saved?: boolean;
};

type AuditItem = {
  action: string;
  detail: string;
  actor: string;
  time: string;
  tone: "blue" | "green" | "amber" | "neutral";
};

type CRMUser = {
  email: string;
  displayName: string;
};

type SessionUser = CRMUser & {
  role: "admin" | "user";
  tenantId: string;
  teamId: string;
};

type AdminTeam = {
  id: string;
  name: string;
};

type AdminMember = {
  userId: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  teamId: string | null;
};

type AdminPermission = {
  id: string;
  role: "admin" | "user";
  object: string;
  action: string;
  scope: "personal" | "team" | "tenant";
};

type AdminInvitation = {
  id: string;
  email: string;
  role: "admin" | "user";
  teamId: string | null;
  status: string;
};

type AdminAccessPayload = {
  teams: AdminTeam[];
  members: AdminMember[];
  permissions: AdminPermission[];
  invitations: AdminInvitation[];
};

const navigation = [
  { id: "dashboard" as View, label: "Vue d’ensemble", icon: LayoutDashboard },
  { id: "pipeline" as View, label: "Pipeline", icon: Columns3, badge: "14" },
  { id: "objects" as View, label: "Objets métier", icon: Database },
  { id: "automations" as View, label: "Automatisations", icon: Workflow },
];

const adminNavigation = [
  { id: "rights" as View, label: "Droits & équipes", icon: ShieldCheck },
  { id: "modules" as View, label: "Modules", icon: Boxes },
  { id: "data" as View, label: "Données & API", icon: SlidersHorizontal },
  { id: "audit" as View, label: "Journal d’audit", icon: ScrollText },
];

const stages: { id: Stage; label: string; accent: string }[] = [
  { id: "qualification", label: "Qualification", accent: "#94a3b8" },
  { id: "decouverte", label: "Découverte", accent: "#60a5fa" },
  { id: "proposition", label: "Proposition", accent: "#818cf8" },
  { id: "negociation", label: "Négociation", accent: "#f59e0b" },
  { id: "gagne", label: "Gagné", accent: "#10b981" },
];

const demoDeals: Deal[] = [
  { id: "d1", name: "Refonte réseau agences", company: "Nordis Groupe", amount: 48000, stage: "qualification", owner: "ML", due: "12 sept.", confidence: 25 },
  { id: "d2", name: "Suite conformité", company: "Alta Finance", amount: 28000, stage: "qualification", owner: "SC", due: "16 sept.", confidence: 20 },
  { id: "d3", name: "Migration cloud hybride", company: "Helio Santé", amount: 82000, stage: "decouverte", owner: "ML", due: "18 sept.", confidence: 45 },
  { id: "d4", name: "Portail partenaires", company: "Valmont Industrie", amount: 36500, stage: "decouverte", owner: "JA", due: "20 sept.", confidence: 40 },
  { id: "d5", name: "SOC managé", company: "Kanso Retail", amount: 64000, stage: "proposition", owner: "SC", due: "11 sept.", confidence: 65 },
  { id: "d6", name: "Audit Zero Trust", company: "Mirova Conseil", amount: 22500, stage: "proposition", owner: "ML", due: "14 sept.", confidence: 70 },
  { id: "d7", name: "Supervision unifiée", company: "Atelier 27", amount: 41000, stage: "negociation", owner: "JA", due: "10 sept.", confidence: 80 },
  { id: "d8", name: "PRA multi-sites", company: "Orbis Logistique", amount: 73500, stage: "gagne", owner: "SC", due: "Signé", confidence: 100 },
];

const revenueData = [
  { month: "Avr", realised: 72, forecast: 78 },
  { month: "Mai", realised: 84, forecast: 86 },
  { month: "Juin", realised: 81, forecast: 94 },
  { month: "Juil", realised: 96, forecast: 101 },
  { month: "Août", realised: 104, forecast: 112 },
  { month: "Sept", realised: 110, forecast: 128 },
];

const funnelData = [
  { label: "Leads", value: 92 },
  { label: "Qualifiés", value: 63 },
  { label: "Propositions", value: 38 },
  { label: "Gagnés", value: 21 },
];

const businessObjects = [
  { name: "Sociétés", plural: "Sociétés", fields: 18, records: 248, owner: "Équipe CRM", status: "Actif" },
  { name: "Contacts", plural: "Contacts", fields: 24, records: 1842, owner: "Équipe CRM", status: "Actif" },
  { name: "Opportunités", plural: "Opportunités", fields: 21, records: 386, owner: "Ventes", status: "Actif" },
  { name: "Contrats", plural: "Contrats", fields: 14, records: 117, owner: "Juridique", status: "Actif" },
  { name: "Partenaires", plural: "Partenaires", fields: 11, records: 39, owner: "Alliances", status: "Brouillon" },
];

const automationRules = [
  { id: "a1", name: "Relance après proposition", trigger: "Opportunité sans activité pendant 3 jours", action: "Créer une tâche et notifier le propriétaire", runs: "42 ce mois", enabled: true },
  { id: "a2", name: "Qualification des leads", trigger: "Score du contact supérieur à 70", action: "Créer une opportunité en Qualification", runs: "18 ce mois", enabled: true },
  { id: "a3", name: "Validation remise", trigger: "Remise commerciale supérieure à 15 %", action: "Demander l’accord du responsable commercial", runs: "7 ce mois", enabled: true },
  { id: "a4", name: "Clôture administrative", trigger: "Opportunité passée à Gagné", action: "Créer le contrat et prévenir la finance", runs: "11 ce mois", enabled: false },
];

const initialAudit: AuditItem[] = [
  { action: "Opportunité déplacée", detail: "Supervision unifiée → Négociation", actor: "Jules Arnaud", time: "Il y a 12 min", tone: "blue" },
  { action: "Règle exécutée", detail: "Relance après proposition · Kanso Retail", actor: "Automatisation", time: "Il y a 34 min", tone: "green" },
  { action: "Droit modifié", detail: "Équipe Support · export désactivé", actor: "Mélanie Laurent", time: "Aujourd’hui, 09:18", tone: "amber" },
  { action: "Import terminé", detail: "contacts-septembre.csv · 126 lignes", actor: "Sarah Cohen", time: "Hier, 17:42", tone: "neutral" },
  { action: "Champ ajouté", detail: "Opportunité · Type de renouvellement", actor: "Mélanie Laurent", time: "Hier, 14:06", tone: "blue" },
];

const viewTitles: Record<View, { title: string; description: string }> = {
  dashboard: { title: "Bonjour Mélanie", description: "Voici les priorités commerciales du 9 septembre." },
  pipeline: { title: "Pipeline commercial", description: "Pilotez les opportunités et leur prochaine action." },
  objects: { title: "Objets métier", description: "Un modèle de données clair, gouverné et réutilisable." },
  automations: { title: "Automatisations", description: "Des règles guidées, lisibles et faciles à maintenir." },
  rights: { title: "Droits & équipes", description: "Accès explicites par rôle, objet et action sensible." },
  modules: { title: "Modules", description: "Activez uniquement les capacités utiles à votre organisation." },
  data: { title: "Données & API", description: "Importez, exportez et intégrez sans perdre la traçabilité." },
  audit: { title: "Journal d’audit", description: "Toutes les actions critiques, dans un historique exploitable." },
};

const euros = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

function Panel({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <section className={`crm-panel ${className}`}>{children}</section>;
}

function PanelTitle({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[1rem] font-semibold tracking-[-0.01em] text-slate-950">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

function StatusPill({ children, tone = "blue" }: { children: React.ReactNode; tone?: "blue" | "green" | "amber" | "neutral" }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

function MetricCard({ label, value, delta, note, tone }: { label: string; value: string; delta: string; note: string; tone: "blue" | "green" | "violet" | "amber" }) {
  return (
    <Panel className={`metric-card metric-${tone}`}>
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-slate-600">{label}</p>
        <span className="metric-mark" />
      </div>
      <div className="mt-5 flex items-end justify-between gap-3">
        <p className="text-[1.75rem] font-semibold tracking-[-0.04em] text-slate-950">{value}</p>
        <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-emerald-700"><ArrowUpRight className="size-3.5" />{delta}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </Panel>
  );
}

function DashboardView({ onNavigate }: { onNavigate: (view: View) => void }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Pipeline pondéré" value="286 k€" delta="12,4 %" note="vs. mois dernier" tone="blue" />
        <MetricCard label="Prévision du mois" value="128 k€" delta="6,8 %" note="87 % de l’objectif" tone="violet" />
        <MetricCard label="Taux de conversion" value="31,6 %" delta="3,2 pts" note="sur 90 jours" tone="green" />
        <MetricCard label="Cycle moyen" value="24 j" delta="8 %" note="3 jours gagnés" tone="amber" />
      </div>

      <div className="focus-strip">
        <div className="flex min-w-0 items-center gap-3">
          <span className="focus-icon"><Target className="size-5" /></span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.11em] text-blue-200">Priorité du jour</p>
            <p className="mt-1 truncate text-sm font-medium text-white">3 opportunités nécessitent une prochaine action</p>
          </div>
        </div>
        <Button onClick={() => onNavigate("pipeline")} className="shrink-0 bg-white text-slate-950 hover:bg-blue-50">Voir le pipeline <ArrowRight className="size-4" /></Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,.8fr)]">
        <Panel>
          <PanelTitle title="Revenu réalisé et prévisionnel" description="En milliers d’euros · 6 derniers mois" action={<StatusPill tone="green">Objectif 147 k€</StatusPill>} />
          <div className="h-[265px] w-full" aria-label="Évolution du revenu réalisé et prévisionnel">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueData} margin={{ top: 10, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="realised" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2563eb" stopOpacity={0.28} /><stop offset="100%" stopColor="#2563eb" stopOpacity={0.01} /></linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#e8edf5" strokeDasharray="3 4" />
                <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#94a3b8", fontSize: 12 }} />
                <RechartsTooltip contentStyle={{ borderRadius: 10, border: "1px solid #dbe3ef", boxShadow: "0 12px 35px rgba(15,23,42,.10)", fontSize: 13 }} />
                <Area type="monotone" dataKey="forecast" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 5" fill="transparent" name="Prévision" />
                <Area type="monotone" dataKey="realised" stroke="#2563eb" strokeWidth={2.5} fill="url(#realised)" name="Réalisé" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex items-center gap-5 text-xs text-slate-500"><span className="flex items-center gap-2"><i className="h-0.5 w-5 bg-blue-600" /> Réalisé</span><span className="flex items-center gap-2"><i className="h-0.5 w-5 border-t-2 border-dashed border-slate-400" /> Prévision</span></div>
        </Panel>

        <Panel>
          <PanelTitle title="Entonnoir commercial" description="Conversion sur 90 jours" />
          <div className="h-[215px]" aria-label="Entonnoir commercial">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnelData} layout="vertical" margin={{ top: 0, right: 15, left: 15, bottom: 0 }}>
                <XAxis type="number" hide domain={[0, 100]} />
                <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#475569", fontSize: 12 }} width={75} />
                <RechartsTooltip cursor={{ fill: "#f8fafc" }} contentStyle={{ borderRadius: 10, border: "1px solid #dbe3ef", fontSize: 13 }} />
                <Bar dataKey="value" fill="#4f46e5" radius={[0, 6, 6, 0]} barSize={18} name="Volume" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="rounded-xl bg-slate-50 p-3 text-sm"><span className="font-semibold text-slate-950">22,8 %</span><span className="ml-2 text-slate-500">de conversion globale</span></div>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,.8fr)]">
        <Panel>
          <PanelTitle title="Opportunités à surveiller" description="Échéance proche ou activité manquante" action={<Button variant="ghost" size="sm" onClick={() => onNavigate("pipeline")}>Tout voir <ArrowRight className="size-4" /></Button>} />
          <div className="space-y-1">
            {demoDeals.slice(4, 7).map((deal, index) => (
              <button key={deal.id} onClick={() => onNavigate("pipeline")} className="watch-row w-full text-left">
                <span className={`watch-rank rank-${index + 1}`}>0{index + 1}</span>
                <span className="min-w-0 flex-1"><strong className="block truncate text-sm text-slate-900">{deal.name}</strong><span className="text-xs text-slate-500">{deal.company}</span></span>
                <span className="hidden text-right sm:block"><strong className="block text-sm text-slate-900">{euros.format(deal.amount)}</strong><span className="text-xs text-slate-500">{deal.due}</span></span>
                <ArrowUpRight className="size-4 text-slate-400" />
              </button>
            ))}
          </div>
        </Panel>

        <Panel>
          <PanelTitle title="Activité récente" action={<Button variant="ghost" size="sm" onClick={() => onNavigate("audit")}>Journal</Button>} />
          <div className="activity-list">
            {initialAudit.slice(0, 4).map((item) => (
              <div className="activity-row" key={item.action + item.time}>
                <span className={`activity-dot dot-${item.tone}`} />
                <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{item.action}</p><p className="mt-0.5 truncate text-xs text-slate-500">{item.detail}</p></div>
                <time className="ml-auto shrink-0 text-xs text-slate-400">{item.time.replace("Il y a ", "")}</time>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function PipelineView({ deals, onAdvance, onOpenCreate, query }: { deals: Deal[]; onAdvance: (deal: Deal) => void; onOpenCreate: () => void; query: string }) {
  const filtered = deals.filter((deal) => `${deal.name} ${deal.company}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm"><Filter className="size-4" /> Tous les propriétaires</Button>
          <Button variant="outline" size="sm"><Calendar className="size-4" /> Ce trimestre</Button>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-500"><span>Pipeline total</span><strong className="text-slate-950">{euros.format(filtered.reduce((sum, deal) => sum + deal.amount, 0))}</strong></div>
      </div>
      <div className="kanban-scroll">
        <div className="kanban-board">
          {stages.map((stage) => {
            const stageDeals = filtered.filter((deal) => deal.stage === stage.id);
            return (
              <section className="kanban-column" key={stage.id} style={{ "--stage": stage.accent } as React.CSSProperties}>
                <header className="kanban-header">
                  <div className="flex items-center gap-2"><span className="stage-dot" /><h2>{stage.label}</h2><Badge variant="secondary">{stageDeals.length}</Badge></div>
                  <span>{euros.format(stageDeals.reduce((sum, deal) => sum + deal.amount, 0))}</span>
                </header>
                <div className="space-y-3">
                  {stageDeals.map((deal) => (
                    <article className="deal-card" key={deal.id}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-950">{deal.name}</h3><p className="mt-1 flex items-center gap-1.5 truncate text-xs text-slate-500"><Building2 className="size-3.5" />{deal.company}</p></div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 shrink-0"><MoreHorizontal className="size-4" /><span className="sr-only">Actions</span></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end"><DropdownMenuLabel>Opportunité</DropdownMenuLabel><DropdownMenuItem onClick={() => toast.info("La fiche détaillée sera reliée à l’objet Opportunité.")}>Ouvrir la fiche</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => onAdvance(deal)}>Passer à l’étape suivante</DropdownMenuItem></DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <p className="mt-4 text-lg font-semibold tracking-[-0.03em] text-slate-950">{euros.format(deal.amount)}</p>
                      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                        <span className="owner-avatar">{deal.owner}</span>
                        <span>{deal.confidence} %</span>
                        <span className="flex items-center gap-1"><Calendar className="size-3.5" />{deal.due}</span>
                      </div>
                    </article>
                  ))}
                  {stageDeals.length === 0 ? <div className="kanban-empty">Aucune opportunité</div> : null}
                  {stage.id === "qualification" ? <button onClick={onOpenCreate} className="add-card"><Plus className="size-4" />Ajouter une opportunité</button> : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ObjectsView() {
  const [objectCount, setObjectCount] = useState(businessObjects.length);
  return (
    <Tabs defaultValue="objects" className="space-y-5">
      <TabsList><TabsTrigger value="objects">Objets</TabsTrigger><TabsTrigger value="relations">Relations</TabsTrigger><TabsTrigger value="governance">Gouvernance</TabsTrigger></TabsList>
      <TabsContent value="objects">
        <Panel>
          <PanelTitle title="Modèle de données" description={`${objectCount} objets activés · 2 modèles disponibles`} action={<Button size="sm" onClick={() => { setObjectCount((count) => count + 1); toast.success("Objet brouillon créé à partir du modèle standard."); }}><Plus className="size-4" />Nouvel objet</Button>} />
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <Table>
              <TableHeader><TableRow><TableHead>Objet</TableHead><TableHead className="hidden md:table-cell">Responsable</TableHead><TableHead>Champs</TableHead><TableHead className="hidden sm:table-cell">Enregistrements</TableHead><TableHead>État</TableHead><TableHead className="w-12" /></TableRow></TableHeader>
              <TableBody>
                {businessObjects.map((object) => (
                  <TableRow key={object.name}><TableCell><div className="flex items-center gap-3"><span className="object-icon"><Database className="size-4" /></span><div><strong className="font-medium text-slate-900">{object.name}</strong><p className="text-xs text-slate-500">Nom pluriel : {object.plural}</p></div></div></TableCell><TableCell className="hidden text-slate-600 md:table-cell">{object.owner}</TableCell><TableCell>{object.fields}</TableCell><TableCell className="hidden sm:table-cell">{object.records.toLocaleString("fr-FR")}</TableCell><TableCell><StatusPill tone={object.status === "Actif" ? "green" : "neutral"}>{object.status}</StatusPill></TableCell><TableCell><Button variant="ghost" size="icon"><Settings2 className="size-4" /><span className="sr-only">Configurer {object.name}</span></Button></TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {[
            ["Modèles guidés", "Démarrez avec des structures validées pour éviter les champs redondants.", Sparkles],
            ["Limites maîtrisées", "80 champs maximum par objet et validation avant publication.", ShieldCheck],
            ["Impact visible", "Chaque changement affiche les vues, règles et API concernées.", Activity],
          ].map(([title, text, Icon]) => <Panel key={String(title)} className="compact-feature"><Icon className="size-5 text-blue-600" /><h3>{String(title)}</h3><p>{String(text)}</p></Panel>)}
        </div>
      </TabsContent>
      <TabsContent value="relations"><Panel><PanelTitle title="Relations entre objets" description="Une cartographie lisible avant toute modification." /><div className="relation-map"><span>Société</span><i /><span>Contact</span><i /><span>Opportunité</span><i /><span>Contrat</span></div><p className="mt-5 text-sm text-slate-500">Les relations critiques sont protégées. Toute suppression nécessite une analyse d’impact et une validation explicite.</p></Panel></TabsContent>
      <TabsContent value="governance"><Panel><PanelTitle title="Règles de gouvernance" description="Des garde-fous qui gardent le CRM maintenable." /><div className="grid gap-3 md:grid-cols-2">{["Détection des champs proches ou doublons", "Publication en deux étapes pour les changements structurants", "Historique et restauration des configurations", "Responsable métier obligatoire par objet"].map((rule) => <div className="rule-line" key={rule}><CheckCircle2 className="size-4 text-emerald-600" />{rule}</div>)}</div></Panel></TabsContent>
    </Tabs>
  );
}

function AutomationsView() {
  const [states, setStates] = useState<Record<string, boolean>>(Object.fromEntries(automationRules.map((rule) => [rule.id, rule.enabled])));
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
      <Panel>
        <PanelTitle title="Règles actives" description="Chaque règle expose clairement son déclencheur et son résultat." action={<Button size="sm" onClick={() => toast.info("Assistant de création ouvert : déclencheur → conditions → actions → test.")}><Plus className="size-4" />Créer une règle</Button>} />
        <div className="space-y-3">
          {automationRules.map((rule) => (
            <article className="automation-card" key={rule.id}>
              <span className="automation-icon"><Workflow className="size-5" /></span>
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-900">{rule.name}</h3><StatusPill tone={states[rule.id] ? "green" : "neutral"}>{states[rule.id] ? "Active" : "En pause"}</StatusPill></div><div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-[1fr_auto_1fr]"><span><small>QUAND</small>{rule.trigger}</span><ArrowRight className="hidden size-4 self-center text-slate-400 md:block" /><span><small>ALORS</small>{rule.action}</span></div><p className="mt-3 text-xs text-slate-400">{rule.runs} · Dernière exécution sans erreur</p></div>
              <Switch checked={states[rule.id]} onCheckedChange={(checked) => { setStates((current) => ({ ...current, [rule.id]: checked })); toast.success(checked ? "Règle activée" : "Règle mise en pause"); }} aria-label={`${states[rule.id] ? "Désactiver" : "Activer"} ${rule.name}`} />
            </article>
          ))}
        </div>
      </Panel>
      <div className="space-y-5">
        <Panel className="guide-card"><span className="guide-icon"><Wand2 className="size-5" /></span><h2>Construire sans code</h2><p>Un parcours en quatre étapes empêche les règles incomplètes ou contradictoires.</p><ol><li><span>1</span>Choisir le déclencheur</li><li><span>2</span>Ajouter les conditions</li><li><span>3</span>Définir les actions</li><li><span>4</span>Tester puis activer</li></ol><Button variant="outline" className="w-full" onClick={() => toast.info("3 modèles recommandés pour votre pipeline.")}>Voir les modèles</Button></Panel>
        <Panel><PanelTitle title="Santé des règles" /><div className="space-y-4"><div><div className="mb-2 flex justify-between text-sm"><span>Exécutions réussies</span><strong>99,4 %</strong></div><Progress value={99.4} /></div><div className="flex items-center gap-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="size-5" />Aucun conflit détecté</div></div></Panel>
      </div>
    </div>
  );
}

function RightsView() {
  const [access, setAccess] = useState<AdminAccessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState({ email: "", role: "user" as "admin" | "user", teamId: "" });
  const [teamName, setTeamName] = useState("");

  const refresh = (showLoading = true) => {
    if (showLoading) setLoading(true);
    fetch("/api/admin/access")
      .then(async (response): Promise<AdminAccessPayload> => {
        if (!response.ok) throw new Error("Administration refusée.");
        return response.json() as Promise<AdminAccessPayload>;
      })
      .then(setAccess)
      .catch((error) => toast.error(error instanceof Error ? error.message : "Administration indisponible."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetch("/api/admin/access")
      .then(async (response): Promise<AdminAccessPayload> => {
        if (!response.ok) throw new Error("Administration refusée.");
        return response.json() as Promise<AdminAccessPayload>;
      })
      .then(setAccess)
      .catch((error) => toast.error(error instanceof Error ? error.message : "Administration indisponible."))
      .finally(() => setLoading(false));
  }, []);

  const createTeam = async () => {
    if (!teamName.trim()) return;
    const response = await fetch("/api/admin/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "create-team", name: teamName }),
    });
    if (!response.ok) {
      toast.error("Création d’équipe refusée.");
      return;
    }
    setTeamName("");
    toast.success("Équipe créée");
    refresh();
  };

  const inviteUser = async () => {
    const response = await fetch("/api/admin/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "invite-user", ...invite, teamId: invite.teamId || null }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(payload?.error ?? "Invitation refusée.");
      return;
    }
    setInvite({ email: "", role: "user", teamId: "" });
    toast.success("Invitation enregistrée");
    refresh();
  };

  const updateMember = async (member: AdminMember, patch: Partial<Pick<AdminMember, "role" | "teamId">>) => {
    const response = await fetch("/api/admin/access", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "update-member",
        userId: member.userId,
        role: patch.role ?? member.role,
        teamId: patch.teamId ?? member.teamId,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(payload?.error ?? "Mise à jour refusée.");
      return;
    }
    toast.success("Membre mis à jour");
    refresh();
  };

  const updatePermission = async (permission: AdminPermission, scope: AdminPermission["scope"]) => {
    const response = await fetch("/api/admin/access", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "update-permission", ...permission, scope }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(payload?.error ?? "Permission refusée.");
      return;
    }
    toast.success("Permission mise à jour");
    refresh();
  };

  const teams = access?.teams ?? [];
  const members = access?.members ?? [];
  const permissions = access?.permissions ?? [];
  const invitations = access?.invitations ?? [];

  return (
    <div className="space-y-5">
      <Panel>
        <PanelTitle title="Membres et rôles" description="Les changements sont persistants, auditables et appliqués côté serveur." action={<Button size="sm" variant="outline" onClick={() => refresh()}><RefreshCw className="size-4" />Actualiser</Button>} />
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <Table><TableHeader><TableRow><TableHead>Membre</TableHead><TableHead>Rôle</TableHead><TableHead className="hidden md:table-cell">Équipe</TableHead><TableHead>État</TableHead></TableRow></TableHeader><TableBody>{loading ? <TableRow><TableCell colSpan={4}>Chargement…</TableCell></TableRow> : members.map((member) => <TableRow key={member.userId}><TableCell><div><strong className="font-medium text-slate-900">{member.displayName}</strong><p className="text-xs text-slate-500">{member.email}</p></div></TableCell><TableCell><Select value={member.role} onValueChange={(role) => updateMember(member, { role: role as "admin" | "user" })}><SelectTrigger className="w-[145px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="admin">Administrateur</SelectItem><SelectItem value="user">Utilisateur</SelectItem></SelectContent></Select></TableCell><TableCell className="hidden md:table-cell"><Select value={member.teamId ?? "none"} onValueChange={(teamId) => updateMember(member, { teamId: teamId === "none" ? null : teamId })}><SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Aucune équipe</SelectItem>{teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select></TableCell><TableCell><StatusPill tone={member.role === "admin" ? "green" : "blue"}>{member.role === "admin" ? "Admin" : "Utilisateur"}</StatusPill></TableCell></TableRow>)}</TableBody></Table>
        </div>
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel><PanelTitle title="Inviter un utilisateur" description="L’invitation prépare rôle et équipe avant la première connexion." /><div className="space-y-3"><Input value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} placeholder="email@societe.fr" /><div className="grid grid-cols-2 gap-3"><Select value={invite.role} onValueChange={(role) => setInvite({ ...invite, role: role as "admin" | "user" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">Utilisateur</SelectItem><SelectItem value="admin">Administrateur</SelectItem></SelectContent></Select><Select value={invite.teamId || "none"} onValueChange={(teamId) => setInvite({ ...invite, teamId: teamId === "none" ? "" : teamId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Aucune équipe</SelectItem>{teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select></div><Button onClick={inviteUser} className="w-full"><Plus className="size-4" />Enregistrer l’invitation</Button></div><div className="mt-5 space-y-2">{invitations.slice(0, 4).map((item) => <div className="setting-line" key={item.id}><div><p>{item.email}</p><span>{item.role === "admin" ? "Administrateur" : "Utilisateur"} · {item.status}</span></div><StatusPill tone="amber">En attente</StatusPill></div>)}</div></Panel>
        <Panel><PanelTitle title="Équipes" description="Les équipes servent aux périmètres de lecture et modification." /><div className="flex gap-2"><Input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Nouvelle équipe" /><Button onClick={createTeam}><Plus className="size-4" /></Button></div><div className="mt-4 space-y-2">{teams.map((team) => <div className="setting-line" key={team.id}><div><p>{team.name}</p><span>{members.filter((member) => member.teamId === team.id).length} membre(s)</span></div><Users className="size-4 text-slate-400" /></div>)}</div></Panel>
      </div>
      <Panel>
        <PanelTitle title="Permissions persistantes" description="Objet, action et périmètre sont stockés et appliqués par les API." />
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <Table><TableHeader><TableRow><TableHead>Profil</TableHead><TableHead>Objet</TableHead><TableHead>Action</TableHead><TableHead>Périmètre</TableHead></TableRow></TableHeader><TableBody>{permissions.filter((permission) => ["opportunity", "audit", "admin"].includes(permission.object)).slice(0, 12).map((permission) => <TableRow key={permission.id}><TableCell>{permission.role === "admin" ? "Administrateur" : "Utilisateur"}</TableCell><TableCell>{permission.object}</TableCell><TableCell>{permission.action}</TableCell><TableCell><Select value={permission.scope} onValueChange={(scope) => updatePermission(permission, scope as AdminPermission["scope"])}><SelectTrigger className="w-[135px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="personal">Personnel</SelectItem><SelectItem value="team">Équipe</SelectItem><SelectItem value="tenant">Tenant</SelectItem></SelectContent></Select></TableCell></TableRow>)}</TableBody></Table>
        </div>
      </Panel>
    </div>
  );
}

function ModulesView() {
  const [installed, setInstalled] = useState<Record<string, boolean>>({ contracts: true, support: true, campaigns: false, billing: false });
  const modules = [
    { id: "contracts", name: "Contrats", description: "Cycles de validation, échéances et renouvellements.", category: "Opérations", icon: ScrollText },
    { id: "support", name: "Support client", description: "Demandes, priorités et engagements de service.", category: "Service", icon: Users },
    { id: "campaigns", name: "Campagnes", description: "Segments, actions marketing et attribution simple.", category: "Marketing", icon: Target },
    { id: "billing", name: "Facturation", description: "Devis, factures et synchronisation comptable.", category: "Finance", icon: Activity },
  ];
  return (
    <div className="space-y-5">
      <Panel className="module-summary"><div><span className="eyebrow">Catalogue maîtrisé</span><h2>Une plateforme qui grandit sans se disperser</h2><p>Chaque module déclare ses objets, ses droits et ses dépendances avant activation.</p></div><div className="module-score"><strong>2 / 4</strong><span>modules actifs</span></div></Panel>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {modules.map((module) => {
          const Icon = module.icon;
          const active = installed[module.id];
          return <Panel className="module-card" key={module.id}><div className="flex items-start justify-between"><span className="module-icon"><Icon className="size-5" /></span><StatusPill tone={active ? "green" : "neutral"}>{active ? "Installé" : "Disponible"}</StatusPill></div><span className="mt-5 block text-xs font-semibold uppercase tracking-[.08em] text-blue-600">{module.category}</span><h3>{module.name}</h3><p>{module.description}</p><Button variant={active ? "outline" : "default"} className="mt-5 w-full" onClick={() => { setInstalled((current) => ({ ...current, [module.id]: !active })); toast.success(active ? `${module.name} désactivé` : `${module.name} activé avec ses réglages recommandés`); }}>{active ? "Gérer" : "Activer"}</Button></Panel>;
        })}
      </div>
      <Panel><PanelTitle title="Règles du catalogue" description="La qualité du socle prime sur le nombre d’extensions." /><div className="grid gap-3 md:grid-cols-3">{[["Dépendances explicites", "Aucun module ne peut modifier silencieusement le modèle de données."], ["Contrat de compatibilité", "Chaque version annonce son impact et son plan de retour arrière."], ["Droits intégrés", "Les nouvelles capacités respectent immédiatement vos rôles existants."]].map(([title, text]) => <div className="governance-card" key={title}><CheckCircle2 className="size-5 text-emerald-600" /><h3>{title}</h3><p>{text}</p></div>)}</div></Panel>
    </div>
  );
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return { rows, valid: !quoted && rows.length > 1 };
}

function DataView({ deals, onAudit }: { deals: Deal[]; onAudit: (item: AuditItem) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileState, setFileState] = useState<{ name: string; rows: number; valid: boolean } | null>(null);

  const exportCsv = async () => {
    const response = await fetch("/api/opportunities/export");
    if (!response.ok) {
      toast.error("Export refusé ou indisponible.");
      return;
    }
    const csv = await response.text();
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "opportunites-clarity-crm.csv"; anchor.click(); URL.revokeObjectURL(url);
    onAudit({ action: "Export généré", detail: `${deals.length} opportunités · CSV UTF-8`, actor: "Mélanie Laurent", time: "À l’instant", tone: "blue" });
    toast.success("Export CSV généré");
  };

  const readFile = async (file?: File) => {
    if (!file) return;
    const parsed = parseCsv(await file.text());
    setFileState({ name: file.name, rows: Math.max(0, parsed.rows.length - 1), valid: parsed.valid });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(330px,.85fr)]">
      <div className="space-y-5">
        <Panel><PanelTitle title="Importer des données" description="Prévisualisation et contrôle avant toute écriture." /><input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => readFile(event.target.files?.[0])} /><button className="drop-zone" onClick={() => fileRef.current?.click()}><span><Upload className="size-6" /></span><strong>Choisir un fichier CSV</strong><small>Encodage UTF-8 · 20 Mo maximum · aucune donnée n’est écrite avant validation</small></button>{fileState ? <div className={`import-result ${fileState.valid ? "valid" : "invalid"}`}><span>{fileState.valid ? <CheckCircle2 className="size-5" /> : <AlertCircle className="size-5" />}</span><div><strong>{fileState.name}</strong><p>{fileState.valid ? `${fileState.rows} lignes détectées · structure valide` : "Structure CSV invalide ou fichier vide"}</p></div><Button size="sm" disabled={!fileState.valid} onClick={() => { onAudit({ action: "Import validé", detail: `${fileState.name} · ${fileState.rows} lignes`, actor: "Mélanie Laurent", time: "À l’instant", tone: "green" }); toast.success("Import ajouté à la file de traitement"); }}>Importer</Button></div> : null}</Panel>
        <Panel><PanelTitle title="Exporter" description="Exports bornés, filtrés et horodatés." /><div className="export-card"><span><Download className="size-5" /></span><div className="flex-1"><h3>Opportunités actives</h3><p>{deals.length} lignes · colonnes métier uniquement · CSV UTF-8</p></div><Button variant="outline" onClick={exportCsv}>Télécharger</Button></div></Panel>
      </div>
      <div className="space-y-5">
        <Panel><PanelTitle title="API" action={<StatusPill tone="green">Opérationnelle</StatusPill>} /><div className="api-box"><code>https://api.clarity-crm.fr/v1</code><Button variant="ghost" size="icon" onClick={() => { navigator.clipboard?.writeText("https://api.clarity-crm.fr/v1"); toast.success("URL copiée"); }}><Key className="size-4" /><span className="sr-only">Copier l’URL</span></Button></div><div className="mt-4 grid grid-cols-2 gap-3"><div className="mini-stat"><strong>99,98 %</strong><span>Disponibilité</span></div><div className="mini-stat"><strong>82 ms</strong><span>Latence P95</span></div></div><Button variant="outline" className="mt-4 w-full" onClick={() => toast.info("La documentation API décrit schémas, erreurs, pagination et idempotence.")}><ScrollText className="size-4" />Documentation API</Button></Panel>
        <Panel><PanelTitle title="Qualité des données" /><div className="space-y-4">{[["Complétude", 94], ["Doublons maîtrisés", 98], ["Données récentes", 87]].map(([label, value]) => <div key={String(label)}><div className="mb-2 flex justify-between text-sm"><span>{label}</span><strong>{value} %</strong></div><Progress value={Number(value)} /></div>)}</div></Panel>
      </div>
    </div>
  );
}

function AuditView({ items }: { items: AuditItem[] }) {
  return (
    <Panel>
      <PanelTitle title="Historique des actions" description="Horodatage, acteur, changement et contexte sont conservés." action={<div className="flex gap-2"><Button variant="outline" size="sm"><Filter className="size-4" />Filtrer</Button><Button variant="outline" size="sm"><Download className="size-4" />Exporter</Button></div>} />
      <div className="audit-timeline">
        {items.map((item, index) => (
          <article className="audit-event" key={`${item.action}-${item.time}-${index}`}>
            <span className={`audit-marker dot-${item.tone}`}><History className="size-4" /></span>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3>{item.action}</h3><StatusPill tone={item.tone}>{item.actor}</StatusPill></div><p>{item.detail}</p></div>
            <time>{item.time}</time>
          </article>
        ))}
      </div>
      <div className="retention-note"><ShieldCheck className="size-5" /><div><strong>Conservation contrôlée : 365 jours</strong><p>Les événements critiques sont non modifiables et exportables par un administrateur autorisé.</p></div></div>
    </Panel>
  );
}

export function CRMShell({ user }: { user: CRMUser }) {
  const [view, setView] = useState<View>("dashboard");
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [deals, setDeals] = useState<Deal[]>(demoDeals);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [audit, setAudit] = useState(initialAudit);
  const [form, setForm] = useState({ name: "", company: "", amount: "", stage: "qualification" as Stage });

  useEffect(() => {
    let active = true;
    fetch("/api/session")
      .then(async (response): Promise<{ user: SessionUser } | null> =>
        response.ok ? (response.json() as Promise<{ user: SessionUser }>) : null,
      )
      .then((payload) => {
        if (active && payload?.user) setSessionUser(payload.user);
      })
      .catch(() => undefined);

    fetch("/api/opportunities")
      .then(async (response): Promise<{ items: Record<string, unknown>[] }> =>
        response.ok ? (response.json() as Promise<{ items: Record<string, unknown>[] }>) : { items: [] },
      )
      .then((payload) => {
        if (!active || !Array.isArray(payload.items) || payload.items.length === 0) return;
        const persisted: Deal[] = payload.items.map((item: Record<string, unknown>) => ({
          id: `p${item.id}`,
          name: String(item.name),
          company: String(item.company),
          amount: Number(item.amount),
          stage: item.stage as Stage,
          owner: String(item.ownerEmail ?? user.email).slice(0, 2).toUpperCase(),
          due: "À planifier",
          confidence: 30,
          saved: true,
        }));
        setDeals([...demoDeals, ...persisted]);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [user.email]);

  const title = viewTitles[view];
  const canAdminister = sessionUser?.role === "admin";
  const filteredCount = useMemo(() => deals.filter((deal) => `${deal.name} ${deal.company}`.toLowerCase().includes(query.toLowerCase())).length, [deals, query]);

  const pushAudit = (item: AuditItem) => setAudit((current) => [item, ...current]);

  const createDeal = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.company.trim() || Number(form.amount) <= 0) {
      toast.error("Renseignez le nom, la société et un montant valide.");
      return;
    }
    setSaving(true);
    const draft: Deal = { id: `local-${Date.now()}`, name: form.name.trim(), company: form.company.trim(), amount: Math.round(Number(form.amount)), stage: form.stage, owner: "ML", due: "À planifier", confidence: 30 };
    let created = false;
    try {
      const response = await fetch("/api/opportunities", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Création refusée.");
      }
      const payload = (await response.json()) as { item: { id: number } };
      draft.id = `p${payload.item.id}`;
      draft.saved = true;
      created = true;
      toast.success("Opportunité enregistrée et auditée");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Création refusée.");
      setSaving(false);
      return;
    } finally {
      if (created) {
        setDeals((current) => [draft, ...current]);
        pushAudit({ action: "Opportunité créée", detail: `${draft.name} · ${euros.format(draft.amount)}`, actor: user.displayName, time: "À l’instant", tone: "green" });
        setForm({ name: "", company: "", amount: "", stage: "qualification" });
        setCreateOpen(false);
        setView("pipeline");
      }
      setSaving(false);
    }
  };

  const advanceDeal = async (deal: Deal) => {
    const index = stages.findIndex((stage) => stage.id === deal.stage);
    if (index === stages.length - 1) { toast.info("Cette opportunité est déjà gagnée."); return; }
    const nextStage = stages[index + 1];
    setDeals((current) => current.map((item) => item.id === deal.id ? { ...item, stage: nextStage.id, confidence: Math.min(100, item.confidence + 20) } : item));
    pushAudit({ action: "Opportunité déplacée", detail: `${deal.name} → ${nextStage.label}`, actor: "Mélanie Laurent", time: "À l’instant", tone: "blue" });
    toast.success(`${deal.name} passe à « ${nextStage.label} »`);
    if (deal.saved) {
      fetch("/api/opportunities", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: Number(deal.id.slice(1)), stage: nextStage.id }) })
        .then((response) => {
          if (!response.ok) throw new Error("Mise à jour refusée côté serveur.");
        })
        .catch((error) => toast.error(error instanceof Error ? error.message : "Mise à jour refusée."));
    }
  };

  const renderView = () => {
    if (view === "dashboard") return <DashboardView onNavigate={setView} />;
    if (view === "pipeline") return <PipelineView deals={deals} onAdvance={advanceDeal} onOpenCreate={() => setCreateOpen(true)} query={query} />;
    if (view === "objects") return <ObjectsView />;
    if (view === "automations") return <AutomationsView />;
    if (view === "rights") return canAdminister ? <RightsView /> : <DashboardView onNavigate={setView} />;
    if (view === "modules") return canAdminister ? <ModulesView /> : <DashboardView onNavigate={setView} />;
    if (view === "data") return canAdminister ? <DataView deals={deals} onAudit={pushAudit} /> : <DashboardView onNavigate={setView} />;
    return canAdminister ? <AuditView items={audit} /> : <DashboardView onNavigate={setView} />;
  };

  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon" className="border-r-0">
        <SidebarHeader className="px-3 py-4">
          <div className="brand-block"><span className="brand-mark">C</span><div className="min-w-0 group-data-[collapsible=icon]:hidden"><strong>Clarity</strong><span>CRM</span></div></div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup><SidebarGroupLabel>ESPACE DE TRAVAIL</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{navigation.map((item) => { const Icon = item.icon; return <SidebarMenuItem key={item.id}><SidebarMenuButton tooltip={item.label} isActive={view === item.id} onClick={() => setView(item.id)}><Icon /><span>{item.label}</span>{item.badge ? <span className="ml-auto rounded-md bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700 group-data-[collapsible=icon]:hidden">{item.badge}</span> : null}</SidebarMenuButton></SidebarMenuItem>; })}</SidebarMenu></SidebarGroupContent></SidebarGroup>
          {canAdminister ? <SidebarGroup><SidebarGroupLabel>ADMINISTRATION</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{adminNavigation.map((item) => { const Icon = item.icon; return <SidebarMenuItem key={item.id}><SidebarMenuButton tooltip={item.label} isActive={view === item.id} onClick={() => setView(item.id)}><Icon /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>; })}</SidebarMenu></SidebarGroupContent></SidebarGroup> : null}
        </SidebarContent>
        <SidebarFooter className="p-3"><button className="profile-card"><span className="profile-avatar">{user.displayName.slice(0, 2).toUpperCase()}</span><span className="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden"><strong>{user.displayName}</strong><small>{sessionUser?.role === "admin" ? "Administrateur" : "Utilisateur"} · {user.email}</small></span><ChevronDown className="size-4 shrink-0 text-slate-400 group-data-[collapsible=icon]:hidden" /></button></SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="topbar">
          <div className="flex items-center gap-3"><SidebarTrigger /><div className="hidden h-5 w-px bg-slate-200 sm:block" /><div className="search-box"><Search className="size-4" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher dans le CRM…" aria-label="Rechercher dans le CRM" /><kbd>⌘ K</kbd>{query ? <span className="hidden text-xs text-slate-500 md:inline">{filteredCount} résultat{filteredCount > 1 ? "s" : ""}</span> : null}</div></div>
          <div className="flex items-center gap-2"><Button variant="ghost" size="icon"><Bell className="size-4" /><span className="sr-only">Notifications</span></Button><Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogTrigger asChild><Button><Plus className="size-4" />Créer</Button></DialogTrigger><DialogContent><form onSubmit={createDeal}><DialogHeader><DialogTitle>Nouvelle opportunité</DialogTitle><DialogDescription>Les champs essentiels uniquement. Vous pourrez enrichir la fiche ensuite.</DialogDescription></DialogHeader><div className="my-6 grid gap-4"><label className="form-field"><span>Nom de l’opportunité</span><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ex. Renouvellement infrastructure" maxLength={100} /></label><label className="form-field"><span>Société</span><Input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} placeholder="Nom du compte" maxLength={100} /></label><div className="grid grid-cols-2 gap-3"><label className="form-field"><span>Montant estimé</span><Input value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} type="number" min="1" step="100" placeholder="25000" /></label><label className="form-field"><span>Étape</span><Select value={form.stage} onValueChange={(value) => setForm({ ...form, stage: value as Stage })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{stages.slice(0, 4).map((stage) => <SelectItem value={stage.id} key={stage.id}>{stage.label}</SelectItem>)}</SelectContent></Select></label></div></div><DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Annuler</Button><Button type="submit" disabled={saving}>{saving ? <RefreshCw className="size-4 animate-spin" /> : <Plus className="size-4" />}{saving ? "Enregistrement…" : "Créer l’opportunité"}</Button></DialogFooter></form></DialogContent></Dialog></div>
        </header>

        <div className="page-shell">
          <div className="page-heading"><div><p className="eyebrow">{view === "dashboard" ? "TABLEAU DE BORD" : "CLARITY CRM"}</p><h1>{title.title}</h1><p>{title.description}</p></div>{view !== "dashboard" && view !== "pipeline" ? <StatusPill tone="green"><Circle className="size-2 fill-current" /> Configuration stable</StatusPill> : null}</div>
          {renderView()}
        </div>
      </SidebarInset>
      <Toaster richColors position="bottom-right" />
    </SidebarProvider>
  );
}
