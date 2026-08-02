import type { GraphNode } from "@/lib/graph/types";
import { slugify } from "@/lib/seo/site";

const VALID_PUBLIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Only entries whose catalog slug differs from `slugify(label)` belong here.
// A contract test compares this client-safe resolver with the complete server
// catalog, so a future label collision cannot silently ship the wrong link.
const TIMELINE_COMPANY_SLUG_OVERRIDES: Readonly<Record<string, string>> = {};

/**
 * Resolve a graph node into the canonical timeline company reference. This is
 * intentionally catalog-backed: stripping `company-` is wrong for renamed or
 * colliding company labels.
 */
export function timelineCompanyRefFromGraphNode(node: GraphNode): { id: string; slug: string; name: string } | null {
  if (node.entityType !== "company") return null;
  const slug = TIMELINE_COMPANY_SLUG_OVERRIDES[node.entityId] ?? slugify(node.label);
  if (!slug || !VALID_PUBLIC_SLUG.test(slug)) return null;
  return { id: node.entityId, slug, name: node.label };
}

export function isValidPublicTimelineSlug(value: string): boolean {
  return value.length <= 90 && VALID_PUBLIC_SLUG.test(value);
}
