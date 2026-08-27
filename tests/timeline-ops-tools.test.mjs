import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarkCompanyTimelines } from "../scripts/benchmark-company-timeline.mjs";
import {
  timelineEventQualityViolations,
  verifyPublicLinks,
} from "../scripts/audit-timeline-quality.mjs";

describe("timeline operational tooling", () => {
  it("uses the structured daily fallback while keeping configured database failures strict", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "daily-benchmarks.yml"), "utf8");
    expect(workflow).toContain("NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}");
    expect(workflow).toContain("SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}");
    expect(workflow).toContain("timeout 4m npm run timeline:backfill:daily");
    expect(workflow).not.toContain("migration_unavailable");
    expect(workflow).toContain("public/timelines");
    expect(workflow).toContain("artifacts/company-timeline/coverage.json");
    expect((workflow.match(/npm run timeline:validate/g) ?? []).length).toBe(1);
    expect(workflow).not.toContain("Refusing to rebuild timeline artifacts without Supabase service-role configuration");
  });

  it("measures bounded timeline and lazy detail responses", async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      const body = url.includes("/api/timeline/events/")
        ? { event: { id: "event-1" } }
        : { events: [{ id: "event-1" }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-timeline-cache": "artifact",
        },
      });
    });

    const result = await benchmarkCompanyTimelines({
      baseUrl: "https://returner.example/path-is-ignored",
      slugs: ["screenpipe"],
      runs: 3,
      warmups: 1,
      fetchImpl,
    });

    expect(result.baseUrl).toBe("https://returner.example");
    expect(result.timelineApi.samples).toBe(3);
    expect(result.eventDetailApi?.samples).toBe(3);
    expect(result.timelineApi.maxPayloadBytes).toBeGreaterThan(0);
    expect(result.cacheOutcomes.artifact).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("refuses a public evidence redirect into a private network", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    }));

    const result = await verifyPublicLinks(["https://returner.example/source"], {
      concurrency: 1,
      timeoutMs: 1_000,
      fetchImpl,
    });

    expect(result.failed).toBe(1);
    expect(result.failures[0]?.reason).toBe("redirect targets a private network");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects generic founder chatter, prospective milestones, and duplicated titles", () => {
    const company = { id: "company-graphify", slug: "graphify-labs", name: "Graphify Labs" };
    const base = {
      title: "As Gabriel mentioned distribution is hard",
      summary: "The company is on track to become the fifth project with 100k stars.",
      category: "traction_milestone",
      sourcePreview: [{ sourceType: "founder_post", title: "As Gabriel mentioned distribution is hard" }],
    };
    expect(timelineEventQualityViolations(company, base)).toEqual(expect.arrayContaining([
      "milestone is not an explicit achieved result",
      "founder-only evidence does not materially identify the company",
    ]));
    expect(timelineEventQualityViolations(company, {
      ...base,
      category: "product_launch",
      title: "Introducing teammate number one",
      summary: "Welcome Nilesh to the team.",
    })).toContain("product launch appears to describe hiring or an anniversary instead of a product release");
    expect(timelineEventQualityViolations(company, {
      ...base,
      category: "product_launch",
      title: "Introducing Graphify knowledge graph engine Introducing Graphify knowledge graph engine",
      summary: "Graphify launched today.",
    })).toContain("title repeats the same opening phrase");
    expect(timelineEventQualityViolations(company, {
      ...base,
      category: "product_launch",
      title: "Graphify Labs launched a new product",
      summary: "Graphify Labs launched today.",
    })).toContain("title uses a generic product-event placeholder");
    expect(timelineEventQualityViolations(company, {
      ...base,
      category: "funding",
      title: "Graphify Labs announced a seed round",
      summary: "Graphify Labs announced a seed round led by Example Ventures,.",
    })).toContain("summary ends with malformed punctuation");
    expect(timelineEventQualityViolations(company, {
      ...base,
      category: "funding",
      title: "Graphify Labs announced Series D",
      summary: "Graphify Labs announced Series D funding.",
    })).not.toContain("title appears to be cut off mid-word");
  });
});
