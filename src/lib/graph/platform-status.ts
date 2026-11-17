import type { PlatformStatus } from "./types";

export const FORWARD_COMPATIBLE_PLATFORM_STATUS: PlatformStatus[] = [
  {
    platform: "threads",
    status: "public_only",
    authMethod: "Native public cards linked from a verified account",
    notes: "Receipt-bound originals remain unscored. Public login frontiers and unknown metric labels do not imply complete history or zero engagement."
  },
  {
    platform: "facebook",
    status: "public_only",
    authMethod: "Explicitly authorized native browser observations",
    notes: "Official-company native posts and typed profile updates are retained with receipt-bound ownership and zero traction. Missing metrics and publication timezones remain unknown."
  },
  {
    platform: "tiktok",
    status: "public_only",
    authMethod: "Explicitly authorized native browser observations",
    notes:
      "Receipt-verified official company TikTok videos and photos can be retained through manual native observations. Evidence remains unscored until a defensible calibration exists."
  },
  {
    platform: "bluesky",
    status: "disabled",
    authMethod: "No Bluesky/AT Protocol adapter configured",
    notes:
      "Verified native Bluesky post URLs can be stored and rendered, but collection is unavailable and evidence remains unscored until a defensible calibration exists."
  }
];

export function withForwardCompatiblePlatformStatus(statuses: PlatformStatus[]): PlatformStatus[] {
  const byPlatform = new Map(statuses.map((status) => [status.platform, status]));
  for (const status of FORWARD_COMPATIBLE_PLATFORM_STATUS) {
    if (!byPlatform.has(status.platform)) {
      byPlatform.set(status.platform, status);
    }
  }
  return [...byPlatform.values()];
}
