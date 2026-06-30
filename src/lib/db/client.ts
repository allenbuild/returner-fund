import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export type AppSupabaseClient = SupabaseClient<Database>;
export type DatabaseMode = "database" | "demo";

export interface SupabaseRuntimeConfig {
  mode: DatabaseMode;
  url: string | null;
  anonKeyConfigured: boolean;
  serviceRoleConfigured: boolean;
}

interface SupabaseCredentials {
  url: string | null;
  anonKey: string | null;
  serviceRoleKey: string | null;
}

let browserClient: AppSupabaseClient | null = null;

function cleanEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readSupabaseCredentials(): SupabaseCredentials {
  const url = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const serviceRoleKey =
    typeof window === "undefined" ? cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY) : null;

  return { url, anonKey, serviceRoleKey };
}

export function getSupabaseRuntimeConfig(): SupabaseRuntimeConfig {
  const { url, anonKey, serviceRoleKey } = readSupabaseCredentials();
  const anonConfigured = Boolean(url && anonKey);

  return {
    mode: anonConfigured ? "database" : "demo",
    url,
    anonKeyConfigured: Boolean(anonKey),
    serviceRoleConfigured: Boolean(serviceRoleKey),
  };
}

export function getDatabaseMode(): DatabaseMode {
  return getSupabaseRuntimeConfig().mode;
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseRuntimeConfig().mode === "database";
}

export function createBrowserSupabaseClient(): AppSupabaseClient | null {
  const { url, anonKey } = readSupabaseCredentials();

  if (!url || !anonKey) {
    return null;
  }

  if (typeof window === "undefined") {
    return createClient<Database>(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
  }

  browserClient ??= createClient<Database>(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });

  return browserClient;
}

export function createServerSupabaseClient(options: { useServiceRole?: boolean } = {}): AppSupabaseClient | null {
  if (options.useServiceRole && typeof window !== "undefined") {
    throw new Error("Service-role Supabase clients can only be created on the server.");
  }

  const { url, anonKey, serviceRoleKey } = readSupabaseCredentials();
  const key = options.useServiceRole ? serviceRoleKey : anonKey;

  if (!url || !key) {
    return null;
  }

  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: {
        "X-Client-Info": "yc-network-intelligence",
      },
    },
  });
}

export function requireServerSupabaseClient(options: { useServiceRole?: boolean } = {}): AppSupabaseClient {
  const client = createServerSupabaseClient(options);

  if (!client) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, or use demo mode.",
    );
  }

  return client;
}
