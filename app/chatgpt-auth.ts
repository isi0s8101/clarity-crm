import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { readNativeIdentity, safeReturnPath } from "@/lib/native-auth";

export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const identity = await readNativeIdentity({ headers: requestHeaders });
  if (!identity) return null;
  return {
    ...identity,
    fullName: identity.displayName,
  };
}

export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safe = safeReturnPath(returnTo);
  return `/login?returnTo=${encodeURIComponent(safe)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safe = safeReturnPath(returnTo);
  return `/login?returnTo=${encodeURIComponent(safe)}`;
}
