"use client";

import { createBrowserSupabaseClient } from "@/lib/db/client";

export type InsiderAuthChangeHandler = () => void;

export async function insiderAccessToken(): Promise<string | null> {
  const client = createBrowserSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
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

export function subscribeToInsiderAuth(handler: InsiderAuthChangeHandler): () => void {
  const client = createBrowserSupabaseClient();
  if (!client) return () => undefined;
  const { data } = client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
      handler();
    }
  });
  return () => data.subscription.unsubscribe();
}
