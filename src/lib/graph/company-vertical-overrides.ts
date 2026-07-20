/**
 * Reviewed company-specific exceptions to deterministic vertical inference.
 *
 * Values stay as canonical slugs and are type-checked by company-verticals.ts.
 * Keeping reviewed data separate prevents company-specific conditionals from
 * leaking into the general classifier.
 */
export const COMPANY_VERTICAL_OVERRIDE_VALUES = {
  "S2026:company-eden-robotics": ["robotics", "manufacturing", "logistics"],
  "S2026:company-9-mothers-corporation": ["defense", "hardware"],
  "S2026:company-dispatch": ["manufacturing", "aerospace", "space"],
  "S26:company-cosmic-robotics": ["robotics", "construction", "space"]
} as const;
