import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";
import {
  addInboxMessage,
  createInboxConversation,
  getInboxConversation,
  listInboxConversations,
  listInboxMessages,
  updateInboxConversation,
} from "@/lib/v12-inbox";
import { readJsonBodyLimited, v12ErrorResponse } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const conversationId = request.nextUrl.searchParams.get("conversationId");
    if (conversationId) {
      const item = await getInboxConversation(actor, conversationId);
      const messages = await listInboxMessages(actor, conversationId, {
        limit: integer(request.nextUrl.searchParams.get("limit")),
        offset: integer(request.nextUrl.searchParams.get("offset")),
      });
      return NextResponse.json({ item, messages });
    }
    const items = await listInboxConversations(actor, {
      status: request.nextUrl.searchParams.get("status"),
      q: request.nextUrl.searchParams.get("q"),
      unread: request.nextUrl.searchParams.get("unread") === "1",
      relatedRecordId: request.nextUrl.searchParams.get("relatedRecordId"),
      limit: integer(request.nextUrl.searchParams.get("limit")),
      offset: integer(request.nextUrl.searchParams.get("offset")),
    });
    return NextResponse.json({ items });
  } catch (error) { return handle(error, "inbox:list"); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    if (body.intent === "message") {
      const item = await addInboxMessage(actor, text(body.conversationId), {
        body: text(body.body),
        direction: optionalText(body.direction),
        senderKind: optionalText(body.senderKind),
        metadata: object(body.metadata) ?? undefined,
      });
      return NextResponse.json({ item }, { status: 201 });
    }
    const item = await createInboxConversation(actor, {
      subject: text(body.subject),
      relatedRecordId: nullableText(body.relatedRecordId),
      assigneeId: nullableText(body.assigneeId),
      status: optionalText(body.status),
      firstMessage: nullableText(body.firstMessage),
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return handle(error, "inbox:create"); }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const item = await updateInboxConversation(actor, text(body.conversationId), {
      status: optionalText(body.status),
      assigneeId: body.assigneeId === undefined ? undefined : nullableText(body.assigneeId),
      markRead: body.markRead === true,
      relatedRecordId: body.relatedRecordId === undefined ? undefined : nullableText(body.relatedRecordId),
    });
    return NextResponse.json({ item });
  } catch (error) { return handle(error, "inbox:update"); }
}

function handle(error: unknown, label: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const v12 = v12ErrorResponse(error); if (v12) return v12;
  console.error(label, error);
  return NextResponse.json({ error: "Inbox indisponible." }, { status: 503 });
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function optionalText(value: unknown) { return typeof value === "string" ? value : undefined; }
function nullableText(value: unknown) { return value === null || value === "" ? null : typeof value === "string" ? value : undefined; }
function integer(value: unknown) { const n = Number(value); return Number.isInteger(n) ? n : undefined; }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
