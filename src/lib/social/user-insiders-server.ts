import type { AppSupabaseClient } from "@/lib/db/client";
import { createServerSupabaseClient } from "@/lib/db/client";
import {
  emptyInsiderConfiguration,
  parseInsiderConfigurationRow,
  type UserInsiderConfiguration
} from "./user-insiders";

export interface AuthenticatedRequest {
  client: AppSupabaseClient;
  userId: string;
}

/**
 * Creates a token-bound client for security-invoker RPCs. The database remains
 * the authority: PostgREST verifies the bearer token and the function uses
 * auth.uid() plus RLS before it can write any user configuration.
 */
export function createInsiderRlsClient(request: Request): AppSupabaseClient | null {
  const accessToken = accessTokenFromRequest(request);
  return accessToken ? createServerSupabaseClient({ accessToken }) : null;
}

export async function authenticateInsiderRequest(request: Request): Promise<AuthenticatedRequest | null> {
  const accessToken = accessTokenFromRequest(request);
  if (!accessToken) return null;

  const client = createServerSupabaseClient({ accessToken });
  if (!client) return null;
  const { data, error } = await client.auth.getClaims(accessToken);
  const userId = data?.claims.sub;
  if (error || !userId) return null;
  return { client, userId };
}

export async function loadUserInsiderConfiguration(
  client: AppSupabaseClient,
  userId: string
): Promise<UserInsiderConfiguration> {
  const { data, error } = await client
    .from("user_insider_configurations")
    .select("version, excluded_default_ids, weight_overrides, added_insiders, created_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingConfigurationTable(error)) return emptyInsiderConfiguration();
    throw error;
  }
  return parseInsiderConfigurationRow(data);
}

function isMissingConfigurationTable(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "42P01" || /user_insider_configurations.*does not exist/i.test(error.message ?? "");
}

function accessTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}
