import assert from "node:assert/strict";

import { summarizeDashboardRecords } from "./dashboard-metrics.js";

const summary = summarizeDashboardRecords({
  now: new Date("2026-09-11T12:00:00Z"),
  opportunities: [
    { status: "active", data: { stage: "qualification", amountCents: 120_000 } },
    { status: "active", data: { stage: "gagne", amountCents: 80_000 } },
    { status: "archived", data: { stage: "proposal", amountCents: 99_000 } },
  ],
  tasks: [
    { status: "active", data: { dueAt: "2026-09-10T12:00:00Z", completed: false } },
    { status: "active", data: { dueAt: "2026-09-12T12:00:00Z", completed: false } },
    { status: "active", data: { completed: true } },
  ],
});

assert.deepEqual(summary, {
  openOpportunities: 1,
  pipelineAmountCents: 120_000,
  stageCounts: { qualification: 1, gagne: 1 },
  wonOpportunities: 1,
  openTasks: 2,
  overdueTasks: 1,
});

console.log("dashboard metrics tests: ok");
