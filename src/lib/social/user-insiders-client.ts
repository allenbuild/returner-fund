"use client";

import { createBrowserSupabaseClient } from "@/lib/db/client";

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
