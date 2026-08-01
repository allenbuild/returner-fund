"use client";

import { createBrowserSupabaseClient } from "@/lib/db/client";

export interface InsiderAuthChange {
  event: "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED";
  userId: string | null;
}

export type InsiderAuthChangeHandler = (change: InsiderAuthChange) => void;

export interface SubscribeToInsiderAuthOptions {
  emitInitial?: boolean;
}

const ACCESS_TOKEN_EXPIRY_LEEWAY_MS = 30_000;
let cachedAccessToken: { value: string; expiresAtMs: number } | null = null;

export async function insiderAccessToken(): Promise<string | null> {
  if (cachedAccessToken && cachedAccessToken.expiresAtMs > Date.now() + ACCESS_TOKEN_EXPIRY_LEEWAY_MS) {
    return cachedAccessToken.value;
  }
  const client = createBrowserSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) {
    cachedAccessToken = null;
    return null;
  }
  rememberAccessToken(data.session.access_token, data.session.expires_at);
  return data.session.access_token;
}

export async function insiderApiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const accessToken = await insiderAccessToken();
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return fetch(input, { ...init, headers });
}

export async function requestInsiderSignInLink(email: string): Promise<void> {
  const client = createBrowserSupabaseClient();
  if (!client) throw new Error("Sign-in is not configured.");
  const redirectTo = new URL(window.location.href);
  redirectTo.hash = "";
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: {
      emailRedirectTo: redirectTo.toString(),
      shouldCreateUser: true
    }
  });
  if (error) throw error;
}

export function subscribeToInsiderAuth(
  handler: InsiderAuthChangeHandler,
  options: SubscribeToInsiderAuthOptions = {}
): () => void {
  const client = createBrowserSupabaseClient();
  if (!client) return () => undefined;
  const { data } = client.auth.onAuthStateChange((event, session) => {
    if (session?.access_token) rememberAccessToken(session.access_token, session.expires_at);
    else cachedAccessToken = null;
    if (
      event === "SIGNED_IN" ||
      event === "SIGNED_OUT" ||
      event === "USER_UPDATED" ||
      (event === "INITIAL_SESSION" && options.emitInitial)
    ) {
      handler({
        event,
        userId: session?.user?.id ?? null
      });
    }
  });
  return () => data.subscription.unsubscribe();
}

function rememberAccessToken(accessToken: string, expiresAtSeconds?: number): void {
  cachedAccessToken = {
    value: accessToken,
    expiresAtMs: expiresAtSeconds
      ? expiresAtSeconds * 1_000
      : Date.now() + ACCESS_TOKEN_EXPIRY_LEEWAY_MS * 2
  };
}
