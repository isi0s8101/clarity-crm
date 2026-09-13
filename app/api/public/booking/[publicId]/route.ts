import { NextRequest, NextResponse } from "next/server";

import {
  getPublicBookingSlots,
  getPublicMetadata,
  submitPublicPublication,
  v12ErrorResponse,
} from "@/lib/v12-planning";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: { publicId: string } }) {
  try {
    const metadata = await getPublicMetadata(context.params.publicId);
    if (metadata.kind !== "appointment_booking") return NextResponse.json({ error: "Publication introuvable." }, { status: 404 });
    const from = request.nextUrl.searchParams.get("from");
    const to = request.nextUrl.searchParams.get("to");
    if (!from || !to) return NextResponse.json({ item: metadata });
    const slots = await getPublicBookingSlots(context.params.publicId, {
      from,
      to,
      durationMinutes: optionalInteger(request.nextUrl.searchParams.get("durationMinutes")),
    });
    return NextResponse.json({ item: metadata, availability: slots });
  } catch (error) { return handle(error); }
}

export async function POST(request: NextRequest, context: { params: { publicId: string } }) {
  try {
    const metadata = await getPublicMetadata(context.params.publicId);
    if (metadata.kind !== "appointment_booking") return NextResponse.json({ error: "Publication introuvable." }, { status: 404 });
    const result = await submitPublicPublication(context.params.publicId, request);
    return NextResponse.json({ recordId: result.recordId, replayed: result.replayed }, { status: result.replayed ? 200 : result.status });
  } catch (error) { return handle(error); }
}

function handle(error: unknown) {
  const response = v12ErrorResponse(error); if (response) return response;
  console.error("public-booking", error);
  return NextResponse.json({ error: "Réservation publique indisponible." }, { status: 503 });
}
function optionalInteger(value: string | null) { const parsed = Number(value); return Number.isInteger(parsed) ? parsed : undefined; }
