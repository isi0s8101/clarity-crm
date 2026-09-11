const WON_STAGES = new Set(["gagne", "won"]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

export function summarizeDashboardRecords({ opportunities = [], tasks = [], now = new Date() } = {}) {
  const referenceTime = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const stageCounts = {};
  let openOpportunities = 0;
  let pipelineAmountCents = 0;
  let wonOpportunities = 0;

  for (const record of opportunities) {
    if (record?.status === "archived") continue;
    const data = asObject(record?.data);
    const stage = typeof data.stage === "string" && data.stage.trim()
      ? data.stage.trim().toLowerCase()
      : "non_defini";
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    if (WON_STAGES.has(stage)) {
      wonOpportunities += 1;
      continue;
    }
    openOpportunities += 1;
    pipelineAmountCents += positiveInteger(data.amountCents);
  }

  let openTasks = 0;
  let overdueTasks = 0;
  for (const record of tasks) {
    if (record?.status === "archived") continue;
    const data = asObject(record?.data);
    if (data.completed === true) continue;
    openTasks += 1;
    const dueAt = typeof data.dueAt === "string" ? Date.parse(data.dueAt) : Number.NaN;
    if (Number.isFinite(dueAt) && dueAt < referenceTime) overdueTasks += 1;
  }

  return {
    openOpportunities,
    pipelineAmountCents,
    stageCounts,
    wonOpportunities,
    openTasks,
    overdueTasks,
  };
}
