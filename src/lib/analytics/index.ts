import { track } from "@vercel/analytics";

type Primitive = string | number | boolean;

export interface AnalyticsEventPayloads {
  search_submitted: {
    result_count: number;
    has_results: boolean;
  };
  result_opened: {
    result_type: "company" | "founder";
    position: number;
  };
  filter_changed: {
    filter: "batch" | "platform" | "industry" | "group_partner" | "top_voices" | "min_score";
    action: "added" | "removed" | "cleared" | "set";
    selection_count: number;
  };
  graph_node_opened: {
    node_type: "company" | "founder";
    source: "graph" | "search" | "leaderboard";
  };
  share_copied: {
    method: "clipboard";
    included_filters: boolean;
    included_node: boolean;
  };
  social_share: {
    method: "native";
    included_filters: boolean;
    included_node: boolean;
  };
  correction_initiated: {
    surface: "node_panel" | "evidence_card";
  };
  report_opened: {
    report_type: "data_quality" | "methodology" | "source";
  };
  related_entity_clicked: {
    entity_type: "company" | "founder" | "voice";
    source: "node_panel";
  };
}

export type AnalyticsEventName = keyof AnalyticsEventPayloads;

type PropertyRule = "boolean" | "count" | readonly string[];

const eventRules: { [EventName in AnalyticsEventName]: Record<keyof AnalyticsEventPayloads[EventName], PropertyRule> } = {
  search_submitted: {
    result_count: "count",
    has_results: "boolean"
  },
  result_opened: {
    result_type: ["company", "founder"],
    position: "count"
  },
  filter_changed: {
    filter: ["batch", "platform", "industry", "group_partner", "top_voices", "min_score"],
    action: ["added", "removed", "cleared", "set"],
    selection_count: "count"
  },
  graph_node_opened: {
    node_type: ["company", "founder"],
    source: ["graph", "search", "leaderboard"]
  },
  share_copied: {
    method: ["clipboard"],
    included_filters: "boolean",
    included_node: "boolean"
  },
  social_share: {
    method: ["native"],
    included_filters: "boolean",
    included_node: "boolean"
  },
  correction_initiated: {
    surface: ["node_panel", "evidence_card"]
  },
  report_opened: {
    report_type: ["data_quality", "methodology", "source"]
  },
  related_entity_clicked: {
    entity_type: ["company", "founder", "voice"],
    source: ["node_panel"]
  }
};

const staticAnalyticsPaths = new Set([
  "/",
  "/about",
  "/cohorts",
  "/companies",
  "/corrections",
  "/data-sources",
  "/faq",
  "/founders",
  "/industries",
  "/methodology",
  "/partners",
  "/platforms",
  "/rankings",
  "/search"
]);
const dynamicAnalyticsRoots = new Set(["cohorts", "companies", "founders", "industries", "partners", "platforms"]);

export function sanitizeAnalyticsProperties(
  name: AnalyticsEventName,
  properties: Record<string, unknown>
): Record<string, Primitive> {
  const safeProperties: Record<string, Primitive> = {};

  for (const [key, rule] of Object.entries(eventRules[name])) {
    const value = properties[key];
    if (rule === "boolean" && typeof value === "boolean") {
      safeProperties[key] = value;
    } else if (rule === "count" && typeof value === "number" && Number.isFinite(value)) {
      safeProperties[key] = Math.max(0, Math.min(1_000, Math.round(value)));
    } else if (Array.isArray(rule) && typeof value === "string" && rule.includes(value)) {
      safeProperties[key] = value;
    }
  }

  return safeProperties;
}

export function trackAnalyticsEvent<EventName extends AnalyticsEventName>(
  name: EventName,
  properties: AnalyticsEventPayloads[EventName]
): void {
  try {
    track(name, sanitizeAnalyticsProperties(name, properties));
  } catch {
    // Telemetry must never interrupt the dashboard interaction it observes.
  }
}

export function privacySafeAnalyticsUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "https://analytics.invalid");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const dynamicRoot = pathname.split("/")[1];
    const safePath = staticAnalyticsPaths.has(pathname)
      ? pathname
      : dynamicAnalyticsRoots.has(dynamicRoot)
        ? `/${dynamicRoot}/_entity`
        : "/other";
    return url.origin === "https://analytics.invalid" ? safePath : `${url.origin}${safePath}`;
  } catch {
    return "/";
  }
}
