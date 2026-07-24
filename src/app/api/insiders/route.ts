import { NextResponse } from "next/server";
import type { JsonObject } from "@/types/database";
import {
  addedInsidersAsJson,
  configurationResponse,
  emptyInsiderConfiguration,
  parseInsiderConfigurationRow,
  validateInsiderConfiguration
} from "@/lib/social/user-insiders";
import {
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
} from "@/lib/social/user-insiders-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authenticated = await authenticateInsiderRequest(request);
  if (!authenticated) {
    return noStoreJson(configurationResponse(emptyInsiderConfiguration(), false));
  }
  try {
    const configuration = await loadUserInsiderConfiguration(authenticated.client, authenticated.userId);
    return noStoreJson(configurationResponse(configuration, true));
  } catch (error) {
    console.error("Insiders configuration load failed", error);
    return errorJson(500, "configuration_load_failed", "Your Insiders list could not be loaded.");
  }
}

export async function PUT(request: Request) {
  const authenticated = await authenticateInsiderRequest(request);
  if (!authenticated) {
    return errorJson(401, "authentication_required", "Sign in to save a private Insiders list.");
  }

  let input: ReturnType<typeof validateInsiderConfiguration>;
  try {
    input = validateInsiderConfiguration(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Insiders configuration.";
    return errorJson(400, "invalid_configuration", message);
  }

  const { data, error } = await authenticated.client.rpc("save_user_insider_configuration", {
    p_expected_version: input.expectedVersion,
    p_excluded_default_ids: input.excludedDefaultIds,
    p_weight_overrides: input.weightOverrides as JsonObject,
    p_added_insiders: addedInsidersAsJson(input.addedInsiders)
  });
  if (error) {
    const conflict = error.code === "40001" || /changed in another session/i.test(error.message);
    if (conflict) {
      return errorJson(409, "configuration_conflict", "This list changed in another tab. Reload it before saving.");
    }
    console.error("Insiders configuration save failed", error);
    return errorJson(500, "configuration_save_failed", "No changes were saved. Please try again.");
  }

  try {
    const configuration = parseInsiderConfigurationRow(data);
    return noStoreJson(configurationResponse(configuration, true));
  } catch (error) {
    console.error("Saved Insiders configuration was invalid", error);
    return errorJson(500, "configuration_response_invalid", "The list was saved but could not be reloaded.");
  }
}

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}

function errorJson(status: number, code: string, message: string) {
  return noStoreJson({ error: { code, message } }, status);
}
