import { NextRequest } from "next/server";

import { GET as handleGet, POST as handlePost } from "../handler";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ publicId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  return handleGet(request, { params });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  return handlePost(request, { params });
}
