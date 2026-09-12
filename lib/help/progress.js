export function progressStorageKey(procedureId) {
  return `clarity.help.progress.${procedureId}`;
}

export function normalizeProgress(value, procedure) {
  if (!value || typeof value !== "object") return { version: procedure.version, step: 0, completed: false };
  if (value.version !== procedure.version) return { version: procedure.version, step: 0, completed: false };
  const maxStep = Math.max(0, procedure.steps.length - 1);
  const step = Number.isInteger(value.step) ? Math.min(Math.max(0, value.step), maxStep) : 0;
  return {
    version: procedure.version,
    step,
    completed: value.completed === true,
  };
}

export function readProgress(storage, procedure) {
  try {
    const raw = storage.getItem(progressStorageKey(procedure.id));
    return normalizeProgress(raw ? JSON.parse(raw) : null, procedure);
  } catch {
    return { version: procedure.version, step: 0, completed: false };
  }
}

export function writeProgress(storage, procedure, progress) {
  const normalized = normalizeProgress(progress, procedure);
  storage.setItem(progressStorageKey(procedure.id), JSON.stringify(normalized));
  return normalized;
}

export function resetProgress(storage, procedureId) {
  storage.removeItem(progressStorageKey(procedureId));
}