import { describe, expect, it } from "vitest";
import {
  POST_TOPIC_CLASSIFIER_VERSION,
  POST_TOPIC_SLUGS,
  POST_TOPIC_TAXONOMY,
  POST_TOPIC_TAXONOMY_VERSION,
  classifyPostTopics,
  extractPostVisibleText,
  extractTopicSignals,
  normalizePostTopic,
  normalizePostTopics
} from "@/lib/graph/post-topics";

describe("post topic taxonomy v2", () => {
  it("has a concise, grouped canonical vocabulary and maps v1 IDs safely", () => {
    expect(POST_TOPIC_TAXONOMY).toHaveLength(14);
    expect(new Set(POST_TOPIC_SLUGS).size).toBe(14);
    expect(POST_TOPIC_TAXONOMY.every((topic) => topic.group && topic.description.length > 35)).toBe(true);
    expect(POST_TOPIC_TAXONOMY_VERSION).toBe("post-topics-2026-07-23");
    expect(POST_TOPIC_CLASSIFIER_VERSION).toBe("post-topics-rules-2026-07-23.1");
    expect(POST_TOPIC_SLUGS).not.toContain("other");
    expect(normalizePostTopic("Other")).toBe("corporate-update");
    expect(normalizePostTopic("Product Showcase")).toBe("product-demo-showcase");
    expect(normalizePostTopic("YC Acceptance")).toBe("accelerator-program");
    expect(normalizePostTopics(["traction", "customer win", "bogus"])).toEqual([
      "traction-growth", "customer-partnership-deployment"
    ]);
  });

  it.each([
    ["traction-growth", "We crossed 12,000 paid users and grew 48% this quarter."],
    ["product-launch", "We just launched our public beta and it is available today."],
    ["product-demo-showcase", "Watch our product walkthrough to see the workflow in action."],
    ["customer-partnership-deployment", "Acme selected us for a paid deployment after a successful pilot."],
    ["fundraising-financing", "We raised $8M in our seed round."],
    ["accelerator-program", "We were accepted into Y Combinator's Summer 2026 batch."],
    ["hiring-team", "We're hiring a staff engineer — join our team."],
    ["company-vision-founder-perspective", "Our mission is to make specialized care available to everyone."],
    ["research-benchmark-technical-insight", "Our benchmark results show the new evaluation outperforms prior models."],
    ["event-media-community", "Join us at the conference for our webinar and customer panel."],
    ["educational-informational", "A step-by-step guide to evaluating agent reliability."],
    ["humor-culture", "Expectation vs reality: the deployment meme of the week."],
  ] as const)("classifies %s from required evidence", (topic, text) => {
    const result = classifyPostTopics({ text });
    expect(result.primaryTopic).toBe(topic);
    expect(result.topics).toEqual([topic]);
    expect(result.confidence).toBeGreaterThanOrEqual(0.58);
  });

  it("does not confuse adjacent categories or create redundant labels", () => {
    expect(classifyPostTopics({ text: "We build software and happen to be a YC company." }).primaryTopic).toBe("corporate-update");
    expect(classifyPostTopics({ text: "Revenue matters to every business." }).primaryTopic).toBe("corporate-update");
    expect(classifyPostTopics({ text: "A Product Hunt page for our product." }).primaryTopic).toBe("corporate-update");
    const launch = classifyPostTopics({ text: "We launched version 2.0 today. Here is a demo." });
    expect(launch.primaryTopic).toBe("product-launch");
    expect(launch.topics).toHaveLength(1);
  });

  it("keeps curated overrides authoritative and makes uncertainty reviewable", () => {
    const curated = classifyPostTopics({ explicitTopics: ["Customer Win"], text: "We raised $8M." });
    expect(curated).toMatchObject({ primaryTopic: "customer-partnership-deployment", method: "curated", confidence: 1, needsReview: false });
    const unknown = classifyPostTopics({ text: "hello" });
    expect(unknown).toMatchObject({ primaryTopic: "unclassified", needsReview: true, method: "fallback" });
  });

  it("reserves Unclassified for genuinely thin content and recognizes terse repositories", () => {
    expect(classifyPostTopics({ text: "hello" }).primaryTopic).toBe("unclassified");
    expect(classifyPostTopics({
      text: "The best founders learn by shipping every week.",
      authorType: "founder"
    }).primaryTopic).toBe("company-vision-founder-perspective");
    expect(classifyPostTopics({
      title: "InsForge/CLI: InsForge CLI (TypeScript).",
      platform: "github",
      mediaType: "repo"
    }).primaryTopic).toBe("corporate-update");
  });

  it("extracts structured facts independently from the topic", () => {
    const signals = extractTopicSignals("We raised $4M after reaching 12,000 users and are hiring.", "founder");
    for (const expected of [
      "contains_quantified_metric", "funding_amount_mentioned", "user_count_mentioned", "hiring_call_to_action", "founder_authored"
    ]) expect(signals).toContain(expected);
  });

  it("uses only visible raw fields, never metrics or target metadata", () => {
    const raw = JSON.stringify({ metrics: { users: 50_000 }, target: { title: "YC company" }, post: { caption: "A step-by-step guide to our workflow." } });
    expect(extractPostVisibleText(raw)).toBe("A step-by-step guide to our workflow.");
    expect(classifyPostTopics({ rawVisibleText: raw }).primaryTopic).toBe("educational-informational");
  });
});
