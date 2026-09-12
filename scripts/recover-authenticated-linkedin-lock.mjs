import { createClient } from "@supabase/supabase-js";
import {
  recoverAuthenticatedLinkedInSafetyQuarantine,
  validateAuthenticatedLinkedInLockRecoveryRequest
} from "./lib/authenticated-linkedin-lock-recovery.mjs";

try {
  const request = validateAuthenticatedLinkedInLockRecoveryRequest(process.env);
  const supabaseUrl = cleanSecret(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanSecret(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Authenticated LinkedIn lock recovery requires Supabase service-role configuration.");
  }
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: { headers: { "X-Client-Info": "returner-linkedin-lock-recovery" } }
  });
  const result = await recoverAuthenticatedLinkedInSafetyQuarantine(client, request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Never render the caught error: an upstream transport may echo the RPC
  // payload, which contains the lease token used for the exact fenced release.
  process.stderr.write("Authenticated LinkedIn lock recovery failed closed.\n");
  process.exitCode = 1;
}

function cleanSecret(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
