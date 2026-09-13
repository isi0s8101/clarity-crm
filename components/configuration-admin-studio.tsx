"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { AdminOperations } from "@/components/admin-operations";

type Item = {
  id: string;
  kind: string;
  name: string;
  version?: number;
  active: boolean;
  definition: Record<string, unknown>;
};
type VersionItem = Item & { createdAt?: string };
type BuiltinTemplate = { key: string; name: string; description: string };
type FieldRow = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  min: string;
  max: string;
  minLength: string;
  maxLength: string;
  pattern: string;
  options: string;
};
type TransitionRow = { from: string; to: string };

const kinds = ["object", "form", "pipeline", "relation", "module", "template"];
const fieldTypes = ["text", "textarea", "number", "currency", "boolean", "date", "datetime", "select"];
const cardinalities = ["one_to_one", "one_to_many", "many_to_one", "many_to_many"];
const emptyField = (): FieldRow => ({
  key: "",
  label: "",
  type: "text",
  required: false,
  min: "",
  max: "",
  minLength: "",
  maxLength: "",
  pattern: "",
  options: "",
});

export function ConfigurationAdminStudio({ items, onSaved }: { items: Item[]; onSaved: () => void }) {
  const [selectedId, setSelectedId] = useState("");
  const [kind, setKind] = useState("object");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [active, setActive] = useState(true);
  const [objectType, setObjectType] = useState("");
  const [relationTarget, setRelationTarget] = useState("");
  const [cardinality, setCardinality] = useState("many_to_one");
  const [rows, setRows] = useState<FieldRow[]>([]);
  const [transitions, setTransitions] = useState<TransitionRow[]>([]);
  const [dependsOn, setDependsOn] = useState("");
  const [expertDefinition, setExpertDefinition] = useState("{}");
  const [history, setHistory] = useState<VersionItem[]>([]);
  const [templates, setTemplates] = useState<BuiltinTemplate[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    fetch("/api/configurations?kind=template")
      .then(async (response) => {
        const payload = await response.json() as { builtinTemplates?: unknown };
        if (response.ok && Array.isArray(payload.builtinTemplates)) {
          setTemplates(payload.builtinTemplates as BuiltinTemplate[]);
        }
      })
      .catch(() => undefined);
  }, []);

  const impact = useMemo(() => {
    if (!selected) return { dependencies: [] as string[], dependents: [] as Item[] };
    const dependencies = referencesOf(selected);
    const selectedKey = configKey(selected);
    const dependents = selectedKey
      ? items.filter((item) => item.id !== selected.id && referencesOf(item).includes(selectedKey))
      : [];
    return { dependencies, dependents };
  }, [items, selected]);

  const load = (item: Item | null) => {
    setMessage("");
    setHistory([]);
    if (!item) {
      setSelectedId("");
      setKind("object");
      setName("");
      setKey("");
      setActive(true);
      setObjectType("");
      setRelationTarget("");
      setCardinality("many_to_one");
      setRows([]);
      setTransitions([]);
      setDependsOn("");
      setExpertDefinition("{}");
      return;
    }
    const definition = item.definition;
    setSelectedId(item.id);
    setKind(item.kind);
    setName(item.name);
    setKey(String(definition.key ?? ""));
    setActive(item.active);
    setObjectType(String(definition.objectType ?? definition.sourceType ?? ""));
    setRelationTarget(String(definition.targetType ?? ""));
    setCardinality(String(definition.cardinality ?? "many_to_one"));
    setDependsOn(Array.isArray(definition.dependsOn) ? definition.dependsOn.map(String).join(", ") : "");
    setExpertDefinition(JSON.stringify(definition, null, 2));
    const sourceRows = Array.isArray(definition.fields)
      ? definition.fields
      : Array.isArray(definition.stages)
        ? definition.stages
        : [];
    setRows(sourceRows.map((entry) => toFieldRow(entry)));
    setTransitions(
      Array.isArray(definition.transitions)
        ? definition.transitions.map((entry) => {
            const row = isRecord(entry) ? entry : {};
            return { from: String(row.from ?? ""), to: String(row.to ?? "") };
          })
        : [],
    );
    void loadHistory(item.id);
  };

  const loadHistory = async (id: string) => {
    try {
      const response = await fetch(`/api/configurations?historyId=${encodeURIComponent(id)}`);
      const payload = await response.json() as { items?: unknown; error?: unknown };
      if (!response.ok) throw new Error(String(payload.error ?? "Historique indisponible."));
      setHistory(Array.isArray(payload.items) ? payload.items as VersionItem[] : []);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const definition = buildDefinition({
        kind,
        key,
        name,
        objectType,
        relationTarget,
        cardinality,
        rows,
        transitions,
        dependsOn,
        expertDefinition,
      });
      const response = await fetch("/api/configurations", {
        method: selected ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selected
          ? { id: selected.id, name, active, definition }
          : { kind, name, active, definition }),
      });
      const payload = await response.json() as { item?: Item; error?: unknown; code?: unknown };
      if (!response.ok) throw new Error(String(payload.error ?? "Enregistrement impossible."));
      setMessage(selected ? "Nouvelle version enregistrée." : "Configuration créée et versionnée.");
      if (payload.item) load(payload.item);
      onSaved();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: number) => {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/configurations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.id, restoreVersion: version }),
      });
      const payload = await response.json() as { item?: Item; error?: unknown };
      if (!response.ok) throw new Error(String(payload.error ?? "Restauration impossible."));
      setMessage(`Version v${version} restaurée dans une nouvelle version.`);
      if (payload.item) load(payload.item);
      onSaved();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = async (templateKey: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/configurations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "apply-template", templateKey }),
      });
      const payload = await response.json() as { error?: unknown };
      if (!response.ok) throw new Error(String(payload.error ?? "Application du template impossible."));
      setMessage(`Template « ${templateKey} » appliqué.`);
      onSaved();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const updateRow = (index: number, patch: Partial<FieldRow>) => {
    setRows((current) => current.map((row, position) => position === index ? { ...row, ...patch } : row));
  };
  const moveRow = (index: number, offset: -1 | 1) => {
    const next = index + offset;
    if (next < 0 || next >= rows.length) return;
    setRows((current) => {
      const copy = [...current];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  };

  return (
    <div className="space-y-5">
      <form onSubmit={(event) => void save(event)} className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Administration des configurations</h2>
            <p className="mt-1 text-sm text-slate-500">Objets, champs, formulaires, pipelines, relations, modules, templates, versions et impact.</p>
          </div>
          <button type="button" className="rounded-lg border px-3 py-2 text-xs" onClick={() => load(null)}>Nouvelle configuration</button>
        </div>

        <label className="mt-4 block text-sm">
          Configuration
          <select className="mt-1 w-full rounded-lg border px-3 py-2" value={selectedId} onChange={(event) => load(items.find((item) => item.id === event.target.value) ?? null)}>
            <option value="">Créer</option>
            {items.filter((item) => kinds.includes(item.kind)).map((item) => (
              <option key={item.id} value={item.id}>{item.kind} · {item.name} · v{item.version ?? "?"}{item.active ? "" : " · inactive"}</option>
            ))}
          </select>
        </label>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {!selected ? (
            <label className="block text-sm">Type
              <select className="mt-1 w-full rounded-lg border px-3 py-2" value={kind} onChange={(event) => { setKind(event.target.value); setRows([]); setTransitions([]); setExpertDefinition("{}"); }}>
                {kinds.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          ) : <div className="rounded-lg bg-slate-50 p-3 text-sm"><strong>Type :</strong> {kind}<p className="mt-1 text-xs text-slate-500">Le type et la clé technique restent immuables après publication.</p></div>}
          <label className="block text-sm">Nom
            <input required maxLength={120} className="mt-1 w-full rounded-lg border px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="block text-sm">Clé technique stable
            <input required disabled={Boolean(selected)} pattern="[a-z][a-z0-9_]{1,49}" className="mt-1 w-full rounded-lg border px-3 py-2 disabled:bg-slate-100" value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
          <label className="flex items-center gap-2 self-end rounded-lg border p-3 text-sm">
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Configuration active
          </label>
        </div>

        {kind === "object" ? (
          <FieldEditor rows={rows} setRows={setRows} updateRow={updateRow} moveRow={moveRow} />
        ) : null}

        {kind === "form" ? (
          <section className="mt-5">
            <label className="block text-sm">Objet cible
              <input required className="mt-1 w-full rounded-lg border px-3 py-2" value={objectType} onChange={(event) => setObjectType(event.target.value)} />
            </label>
            <RowHeader title="Champs ordonnés" onAdd={() => setRows([...rows, emptyField()])} />
            <div className="space-y-2">
              {rows.map((row, index) => (
                <div key={`${index}-${row.key}`} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto_auto]">
                  <input required placeholder="Clé du champ" className="rounded border px-2 py-1 text-sm" value={row.key} onChange={(event) => updateRow(index, { key: event.target.value })} />
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={row.required} onChange={(event) => updateRow(index, { required: event.target.checked })} /> requis dans ce formulaire</label>
                  <RowActions index={index} length={rows.length} move={moveRow} remove={() => setRows(rows.filter((_, position) => position !== index))} />
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-dashed p-4">
              <strong className="text-sm">Prévisualisation simple</strong>
              <div className="mt-3 space-y-2">{rows.map((row) => <label key={row.key || Math.random()} className="block text-xs">{row.key || "champ"}{row.required ? " *" : ""}<input disabled className="mt-1 w-full rounded border bg-slate-50 px-2 py-1" /></label>)}</div>
            </div>
          </section>
        ) : null}

        {kind === "pipeline" ? (
          <section className="mt-5">
            <label className="block text-sm">Objet cible
              <input required className="mt-1 w-full rounded-lg border px-3 py-2" value={objectType} onChange={(event) => setObjectType(event.target.value)} />
            </label>
            <RowHeader title="Étapes persistantes" onAdd={() => setRows([...rows, emptyField()])} />
            <div className="space-y-2">
              {rows.map((row, index) => (
                <div key={`${index}-${row.key}`} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto]">
                  <input required placeholder="Clé étape" className="rounded border px-2 py-1 text-sm" value={row.key} onChange={(event) => updateRow(index, { key: event.target.value })} />
                  <input required placeholder="Libellé" className="rounded border px-2 py-1 text-sm" value={row.label} onChange={(event) => updateRow(index, { label: event.target.value })} />
                  <RowActions index={index} length={rows.length} move={moveRow} remove={() => setRows(rows.filter((_, position) => position !== index))} />
                </div>
              ))}
            </div>
            <RowHeader title="Transitions autorisées" onAdd={() => setTransitions([...transitions, { from: rows[0]?.key ?? "", to: rows[1]?.key ?? "" }])} />
            <div className="space-y-2">
              {transitions.map((transition, index) => (
                <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto_1fr_auto]">
                  <select required className="rounded border px-2 py-1 text-sm" value={transition.from} onChange={(event) => setTransitions(transitions.map((value, position) => position === index ? { ...value, from: event.target.value } : value))}>{rows.map((row) => <option key={row.key} value={row.key}>{row.key || "—"}</option>)}</select>
                  <span className="self-center text-xs">→</span>
                  <select required className="rounded border px-2 py-1 text-sm" value={transition.to} onChange={(event) => setTransitions(transitions.map((value, position) => position === index ? { ...value, to: event.target.value } : value))}>{rows.map((row) => <option key={row.key} value={row.key}>{row.key || "—"}</option>)}</select>
                  <button type="button" className="text-xs text-red-700" onClick={() => setTransitions(transitions.filter((_, position) => position !== index))}>Retirer</button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {kind === "relation" ? (
          <section className="mt-5 grid gap-3 md:grid-cols-3">
            <label className="block text-sm">Objet source<input required className="mt-1 w-full rounded-lg border px-3 py-2" value={objectType} onChange={(event) => setObjectType(event.target.value)} /></label>
            <label className="block text-sm">Objet cible<input required className="mt-1 w-full rounded-lg border px-3 py-2" value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)} /></label>
            <label className="block text-sm">Cardinalité<select className="mt-1 w-full rounded-lg border px-3 py-2" value={cardinality} onChange={(event) => setCardinality(event.target.value)}>{cardinalities.map((value) => <option key={value}>{value}</option>)}</select></label>
          </section>
        ) : null}

        {kind === "module" ? (
          <label className="mt-5 block text-sm">Dépendances de modules (clés séparées par des virgules)
            <input className="mt-1 w-full rounded-lg border px-3 py-2" value={dependsOn} onChange={(event) => setDependsOn(event.target.value)} placeholder="core_sales, documents" />
          </label>
        ) : null}

        {kind === "template" ? (
          <label className="mt-5 block text-sm">Définition du template
            <textarea required rows={12} className="mt-1 w-full rounded-lg border p-3 font-mono text-xs" value={expertDefinition} onChange={(event) => setExpertDefinition(event.target.value)} />
            <span className="mt-1 block text-xs text-slate-500">Un template contient `configs[]`; chaque entrée réutilise le même moteur de validation serveur.</span>
          </label>
        ) : null}

        {selected ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold">Dépendances et impact</h3>
              <p className="mt-2 text-xs text-slate-500">Les contrôles serveur restent autoritatifs avant toute mutation.</p>
              <p className="mt-3 text-xs"><strong>Références :</strong> {impact.dependencies.length ? impact.dependencies.join(", ") : "aucune"}</p>
              <p className="mt-2 text-xs"><strong>Dépendants :</strong> {impact.dependents.length ? impact.dependents.map((item) => `${item.kind}:${configKey(item)}`).join(", ") : "aucun"}</p>
            </section>
            <section className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold">Historique de versions</h3>
              <div className="mt-2 max-h-40 space-y-2 overflow-auto">
                {history.map((version) => (
                  <div key={`${version.id}-${version.version}`} className="flex items-center justify-between gap-2 rounded border p-2 text-xs">
                    <span>v{version.version} · {version.name}{version.createdAt ? ` · ${new Date(version.createdAt).toLocaleString("fr-FR")}` : ""}</span>
                    {version.version !== selected.version ? <button disabled={busy} type="button" className="rounded border px-2 py-1" onClick={() => void restore(Number(version.version))}>Restaurer</button> : <span className="text-slate-500">courante</span>}
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : null}

        <details className="mt-5 rounded-xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">Diagnostic / définition générée</summary>
          <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{safePreview(() => buildDefinition({ kind, key, name, objectType, relationTarget, cardinality, rows, transitions, dependsOn, expertDefinition }))}</pre>
        </details>

        {message ? <p className="mt-3 rounded-lg border bg-slate-50 p-3 text-sm">{message}</p> : null}
        <button disabled={busy} className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{selected ? "Enregistrer une nouvelle version" : "Créer et versionner"}</button>
      </form>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Templates intégrés</h2>
        <p className="mt-1 text-sm text-slate-500">Application atomique via `/api/configurations`, sans moteur parallèle.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {templates.map((template) => (
            <article key={template.key} className="rounded-xl border p-3">
              <strong className="text-sm">{template.name}</strong>
              <p className="mt-1 text-xs text-slate-500">{template.description}</p>
              <button disabled={busy} type="button" onClick={() => void applyTemplate(template.key)} className="mt-3 rounded border px-2 py-1 text-xs">Appliquer</button>
            </article>
          ))}
        </div>
      </section>

      <AdminOperations />
    </div>
  );
}

function FieldEditor({
  rows,
  setRows,
  updateRow,
  moveRow,
}: {
  rows: FieldRow[];
  setRows: (rows: FieldRow[]) => void;
  updateRow: (index: number, patch: Partial<FieldRow>) => void;
  moveRow: (index: number, offset: -1 | 1) => void;
}) {
  return (
    <section className="mt-5">
      <RowHeader title="Champs personnalisés" onAdd={() => setRows([...rows, emptyField()])} />
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="rounded-xl border p-3">
            <div className="grid gap-2 md:grid-cols-4">
              <input required placeholder="Clé" className="rounded border px-2 py-1 text-sm" value={row.key} onChange={(event) => updateRow(index, { key: event.target.value })} />
              <input required placeholder="Libellé" className="rounded border px-2 py-1 text-sm" value={row.label} onChange={(event) => updateRow(index, { label: event.target.value })} />
              <select className="rounded border px-2 py-1 text-sm" value={row.type} onChange={(event) => updateRow(index, { type: event.target.value })}>{fieldTypes.map((value) => <option key={value}>{value}</option>)}</select>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={row.required} onChange={(event) => updateRow(index, { required: event.target.checked })} /> obligatoire</label>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <input type="number" placeholder="min" className="rounded border px-2 py-1 text-xs" value={row.min} onChange={(event) => updateRow(index, { min: event.target.value })} />
              <input type="number" placeholder="max" className="rounded border px-2 py-1 text-xs" value={row.max} onChange={(event) => updateRow(index, { max: event.target.value })} />
              <input type="number" min="0" max="10000" placeholder="minLength" className="rounded border px-2 py-1 text-xs" value={row.minLength} onChange={(event) => updateRow(index, { minLength: event.target.value })} />
              <input type="number" min="0" max="10000" placeholder="maxLength" className="rounded border px-2 py-1 text-xs" value={row.maxLength} onChange={(event) => updateRow(index, { maxLength: event.target.value })} />
              <input placeholder="regexp ancrée ^...$" className="rounded border px-2 py-1 text-xs" value={row.pattern} onChange={(event) => updateRow(index, { pattern: event.target.value })} />
              <input disabled={row.type !== "select"} placeholder="options: A, B, C" className="rounded border px-2 py-1 text-xs disabled:bg-slate-100" value={row.options} onChange={(event) => updateRow(index, { options: event.target.value })} />
            </div>
            <div className="mt-2 flex justify-end"><RowActions index={index} length={rows.length} move={moveRow} remove={() => setRows(rows.filter((_, position) => position !== index))} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RowHeader({ title, onAdd }: { title: string; onAdd: () => void }) {
  return <div className="mb-2 mt-4 flex items-center justify-between"><strong className="text-sm">{title}</strong><button type="button" onClick={onAdd} className="rounded border px-2 py-1 text-xs">Ajouter</button></div>;
}

function RowActions({ index, length, move, remove }: { index: number; length: number; move: (index: number, offset: -1 | 1) => void; remove: () => void }) {
  return <div className="flex gap-1"><button type="button" disabled={index === 0} onClick={() => move(index, -1)} className="rounded border px-2 py-1 text-xs disabled:opacity-30">↑</button><button type="button" disabled={index === length - 1} onClick={() => move(index, 1)} className="rounded border px-2 py-1 text-xs disabled:opacity-30">↓</button><button type="button" onClick={remove} className="rounded border border-red-200 px-2 py-1 text-xs text-red-700">Retirer</button></div>;
}

function toFieldRow(value: unknown): FieldRow {
  const row = isRecord(value) ? value : {};
  return {
    key: String(row.key ?? ""),
    label: String(row.label ?? row.key ?? ""),
    type: String(row.type ?? "text"),
    required: row.required === true,
    min: numberString(row.min),
    max: numberString(row.max),
    minLength: numberString(row.minLength),
    maxLength: numberString(row.maxLength),
    pattern: String(row.pattern ?? ""),
    options: Array.isArray(row.options) ? row.options.map(String).join(", ") : "",
  };
}

function buildDefinition(input: {
  kind: string;
  key: string;
  name: string;
  objectType: string;
  relationTarget: string;
  cardinality: string;
  rows: FieldRow[];
  transitions: TransitionRow[];
  dependsOn: string;
  expertDefinition: string;
}) {
  if (input.kind === "object") return { key: input.key, label: input.name, fields: input.rows.map(compactField) };
  if (input.kind === "form") return { key: input.key, objectType: input.objectType, fields: input.rows.map((row) => ({ key: row.key, required: row.required })) };
  if (input.kind === "pipeline") return { key: input.key, objectType: input.objectType, stages: input.rows.map((row) => ({ key: row.key, label: row.label })), transitions: input.transitions };
  if (input.kind === "relation") return { key: input.key, sourceType: input.objectType, targetType: input.relationTarget, cardinality: input.cardinality };
  if (input.kind === "module") return { key: input.key, dependsOn: input.dependsOn.split(",").map((value) => value.trim()).filter(Boolean) };
  if (input.kind === "template") {
    const parsed = JSON.parse(input.expertDefinition) as unknown;
    if (!isRecord(parsed)) throw new Error("La définition du template doit être un objet JSON.");
    return { ...parsed, key: input.key };
  }
  throw new Error("Type de configuration non pris en charge par l’éditeur guidé.");
}

function compactField(row: FieldRow) {
  const field: Record<string, unknown> = { key: row.key, label: row.label, type: row.type, required: row.required };
  if (row.min !== "") field.min = Number(row.min);
  if (row.max !== "") field.max = Number(row.max);
  if (row.minLength !== "") field.minLength = Number(row.minLength);
  if (row.maxLength !== "") field.maxLength = Number(row.maxLength);
  if (row.pattern.trim()) field.pattern = row.pattern.trim();
  if (row.type === "select") field.options = row.options.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
  return field;
}

function configKey(item: Item) {
  return typeof item.definition.key === "string" ? item.definition.key : "";
}

function referencesOf(item: Item) {
  const definition = item.definition;
  const refs = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) refs.add(value); };
  if (item.kind === "form" || item.kind === "pipeline") add(definition.objectType);
  if (item.kind === "relation") { add(definition.sourceType); add(definition.targetType); }
  if (item.kind === "module" && Array.isArray(definition.dependsOn)) definition.dependsOn.forEach(add);
  if (item.kind === "object" && Array.isArray(definition.fields)) {
    definition.fields.forEach((field) => { if (isRecord(field)) add(field.targetType); });
  }
  return [...refs];
}

function safePreview(factory: () => unknown) {
  try { return JSON.stringify(factory(), null, 2); } catch (error) { return errorMessage(error); }
}

function numberString(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Erreur inattendue.";
}
