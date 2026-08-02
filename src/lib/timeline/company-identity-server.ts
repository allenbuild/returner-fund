import "server-only";

import { getCatalog } from "@/lib/seo/catalog";

/** Resolve the exact slug used by the existing `/companies/[slug]` catalog. */
export function resolvePublicTimelineSlugForEntityId(entityId: string): string | null {
  const normalized = entityId.trim();
  if (!normalized) return null;
  return getCatalog().companies.find((company) => company.node.entityId === normalized)?.slug ?? null;
}
