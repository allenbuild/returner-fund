import type { PlatformStatus } from "./types";

export const FORWARD_COMPATIBLE_PLATFORM_STATUS: PlatformStatus[] = [
  {
    platform: "tiktok",
    status: "disabled",
    authMethod: "No collection adapter configured",
    notes:
      "Verified native TikTok video URLs can be stored and rendered, but collection is unavailable and evidence remains unscored until a defensible calibration exists."
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
