import { appendFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

import {
  runAuthenticatedLinkedInOrphanRecovery,
  validateAuthenticatedLinkedInOrphanRecoveryRequest
} from "./lib/authenticated-linkedin-orphan-recovery.mjs";

try {
  const request =
    validateAuthenticatedLinkedInOrphanRecoveryRequest(process.env);
  const supabaseUrl = cleanSecret(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanSecret(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service-role configuration is required.");
  }
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      headers: { "X-Client-Info": "returner-linkedin-orphan-recovery" }
    }
  });
  const result = await runAuthenticatedLinkedInOrphanRecovery(client, request);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      "status=" +
        result.status +
        "\nfingerprint=" +
        result.fingerprint +
        "\n",
      { mode: 0o600 }
    );
  }
} catch {
  process.stderr.write(
    "Authenticated LinkedIn orphan recovery failed closed.\n"
  );
  process.exitCode = 1;
}

function cleanSecret(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
