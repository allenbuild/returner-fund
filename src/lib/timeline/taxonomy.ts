import { TIMELINE_CATEGORIES, type TimelineCategory } from "./contracts";

export const TIMELINE_TAXONOMY_VERSION = "timeline-taxonomy-2026-08-02.v1" as const;

export const TIMELINE_CATEGORY_LABELS: Readonly<Record<TimelineCategory, string>> = {
  founded: "Founded",
  accelerator: "Accelerator",
  funding: "Funding",
  product_launch: "Product Launch",
  product_update: "Product Update",
  traction_milestone: "Traction Milestone",
  revenue_milestone: "Revenue Milestone",
  user_milestone: "User Milestone",
  customer: "Customer",
  partnership: "Partnership",
  pricing: "Pricing",
  business_model: "Business Model",
  hiring: "Hiring",
  leadership: "Leadership",
  founder: "Founder",
  geographic_expansion: "Geographic Expansion",
  open_source: "Open Source",
  github: "GitHub",
  research: "Research",
  patent: "Patent",
  regulatory: "Regulatory",
  legal: "Legal",
  press: "Press",
  award: "Award",
  acquisition: "Acquisition",
  merger: "Merger",
  exit: "Exit",
  pivot: "Pivot",
  shutdown: "Shutdown",
  website: "Website",
  other: "Other",
};

const CATEGORY_ALIASES: Readonly<Record<string, TimelineCategory>> = {
  founding: "founded",
  launch: "product_launch",
  product: "product_update",
  traction: "traction_milestone",
  revenue: "revenue_milestone",
  users: "user_milestone",
  customers: "customer",
  partnerships: "partnership",
  business: "business_model",
  geographic: "geographic_expansion",
  opensource: "open_source",
  open_source_release: "open_source",
  github_release: "github",
  research_publication: "research",
  patents: "patent",
  regulation: "regulatory",
  lawsuit: "legal",
  awards: "award",
  acquired: "acquisition",
  merged: "merger",
  closed: "shutdown",
};

const CATEGORY_SET = new Set<string>(TIMELINE_CATEGORIES);

export function normalizeTimelineCategory(value: string): TimelineCategory | null {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (CATEGORY_SET.has(normalized)) return normalized as TimelineCategory;
  return CATEGORY_ALIASES[normalized] ?? null;
}
