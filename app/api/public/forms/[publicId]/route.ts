import { NextRequest, NextResponse } from "next/server";

import { getPublicMetadata, submitPublicPublication, v12ErrorResponse } from "@/lib/v12-planning";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: { publicId: string } }) {
  try {
    const item = await getPublicMetadata(context.params.publicId);
    if (item.kind !== "form") return NextResponse.json({ error: "Publication introuvable." }, { status: 404 });
    return NextResponse.json({ item });
  } catch (error) { return handle(error); }
}

export async function POST(request: NextRequest, context: { params: { publicId: string } }) {
  try {
    const metadata = await getPublicMetadata(context.params.publicId);
    if (metadata.kind !== "form") return NextResponse.json({ error: "Publication introuvable." }, { status: 404 });
    const result = await submitPublicPublication(context.params.publicId, request);
    return NextResponse.json({ recordId: result.recordId, replayed: result.replayed }, { status: result.replayed ? 200 : result.status });
  } catch (error) { return handle(error); }
}

function handle(error: unknown) {
  const response = v12ErrorResponse(error); if (response) return response;
  console.error("public-form", error);
  return NextResponse.json({ error: "Formulaire public indisponible." }, { status: 503 });
}
