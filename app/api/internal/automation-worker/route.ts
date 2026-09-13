import { NextRequest, NextResponse } from "next/server";

import { processAutomationJobs } from "@/lib/automation-queue";
import { processSlaOperations } from "@/lib/v11-sla";

export async function POST(request: NextRequest) {
  const expected = process.env.CLARITY_AUTOMATION_WORKER_TOKEN;
  const supplied = request.headers.get("x-clarity-worker-token") ?? "";
  if (!expected || !constantTimeEqual(supplied, expected)) {
    return NextResponse.json({ error: "Accès worker refusé." }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({})) as { workerId?: unknown; limit?: unknown };
    const workerId = typeof body.workerId === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(body.workerId)
      ? body.workerId
      : undefined;
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const [automationProcessed, slaProcessed] = await Promise.all([
      processAutomationJobs({ workerId, limit }),
      processSlaOperations(limit),
    ]);
    return NextResponse.json({ processed: automationProcessed + slaProcessed, automationProcessed, slaProcessed });
  } catch (error) {
    console.error("automation-worker:process", error);
    return NextResponse.json({ error: "Worker d'automatisation indisponible." }, { status: 503 });
  }
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}