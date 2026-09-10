import { NextResponse } from "next/server";

import { checkDatabase } from "@/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ready = await checkDatabase();
    if (!ready) throw new Error("database check failed");
    return NextResponse.json(
      { status: "ready", database: "postgresql" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("health:ready", error);
    return NextResponse.json(
      { status: "not-ready" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
