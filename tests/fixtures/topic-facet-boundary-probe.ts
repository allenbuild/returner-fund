import aliasJson from "@/lib/yc/summer-2026-companies.json";
import relativeJson from "./topic-facet-boundary-relative.json";

export const topicFacetBoundaryProbe = Object.freeze({
  moduleUrl: import.meta.url,
  aliasValue: (aliasJson as { fixtureValue?: string }).fixtureValue ?? null,
  relativeValue: (relativeJson as { fixtureValue?: string }).fixtureValue ?? null
});
