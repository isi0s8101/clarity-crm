#!/usr/bin/env node

const workerId = process.env.CLARITY_AUTOMATION_WORKER_ID || "automation-" + process.pid;
const pollMs = Math.max(250, Math.min(60000, Number(process.env.CLARITY_AUTOMATION_POLL_MS) || 1000));
const baseUrl = (process.env.CLARITY_INTERNAL_BASE_URL || "http://127.0.0.1:5173").replace(/\/$/, "");
const token = process.env.CLARITY_AUTOMATION_WORKER_TOKEN || "";
let stopping = false;
const stop = (signal) => {
  stopping = true;
  console.log(JSON.stringify({ level: "info", component: "automation-worker", event: "stopping", signal, workerId }));
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
console.log(JSON.stringify({ level: "info", component: "automation-worker", event: "started", workerId }));
if (!token) {
  console.error(JSON.stringify({ level: "error", component: "automation-worker", event: "configuration_error", error: "CLARITY_AUTOMATION_WORKER_TOKEN absent" }));
  process.exitCode = 1;
} else while (!stopping) {
  try {
    const response = await fetch(baseUrl + "/api/internal/automation-worker", {
      method: "POST",
      headers: { "content-type": "application/json", "x-clarity-worker-token": token },
      body: JSON.stringify({ workerId, limit: 20 }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const result = await response.json();
    if (!result.processed) await new Promise((resolve) => setTimeout(resolve, pollMs));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", component: "automation-worker", event: "poll_error", workerId, error: error instanceof Error ? error.message : "Erreur inconnue" }));
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
