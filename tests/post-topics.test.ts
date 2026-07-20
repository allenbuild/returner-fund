import { describe, expect, it } from "vitest";
import {
  MAX_AUTOMATIC_POST_TOPICS,
  POST_TOPIC_CLASSIFIER_VERSION,
  POST_TOPIC_SLUGS,
  POST_TOPIC_TAXONOMY,
  POST_TOPIC_TAXONOMY_VERSION,
  classifyPostTopics,
  extractPostVisibleText,
  getPostTopicDefinition,
  isPostTopic,
  normalizePostTopic,
  normalizePostTopics
} from "@/lib/graph/post-topics";

describe("post topic taxonomy", () => {
  it("exposes the exact 25 canonical labels and stable slugs in product order", () => {
    expect(POST_TOPIC_TAXONOMY.map((topic) => topic.label)).toEqual([
      "Traction",
      "Product Showcase",
      "Product Launch",
      "YC Acceptance",
      "Company Vision",
      "Humor",
      "Customer Win",
      "Fundraising",
      "Hiring",
      "Founder Story",
      "Technical Deep Dive",
      "Open Source",
      "Research or Benchmark",
      "Partnership",
      "Demo Day",
      "Milestone",
      "Product Update",
      "Behind the Scenes",
      "Market Insight",
      "Community",
      "Press or Media",
      "Awards",
      "Event",
      "Culture",
      "Other"
    ]);
    expect(POST_TOPIC_SLUGS).toEqual([
      "traction",
      "product-showcase",
      "product-launch",
      "yc-acceptance",
      "company-vision",
      "humor",
      "customer-win",
      "fundraising",
      "hiring",
      "founder-story",
      "technical-deep-dive",
      "open-source",
      "research-or-benchmark",
      "partnership",
      "demo-day",
      "milestone",
      "product-update",
      "behind-the-scenes",
      "market-insight",
      "community",
      "press-or-media",
      "awards",
      "event",
      "culture",
      "other"
    ]);
    expect(new Set(POST_TOPIC_SLUGS).size).toBe(25);
    expect(new Set(POST_TOPIC_TAXONOMY.map((topic) => topic.label)).size).toBe(25);
    expect(POST_TOPIC_TAXONOMY.every((topic) => topic.description.length >= 30)).toBe(true);
    expect(POST_TOPIC_TAXONOMY.every((topic) => topic.aliases.length >= 2)).toBe(true);
    expect(POST_TOPIC_TAXONOMY_VERSION).toBe("post-topics-2026-07-20");
    expect(POST_TOPIC_CLASSIFIER_VERSION).toBe("post-topics-rules-2026-07-20.1");
  });

  it("normalizes slugs, display labels, and aliases without admitting invalid values", () => {
    expect(normalizePostTopic("  Product Showcase ")).toBe("product-showcase");
    expect(normalizePostTopic("Y Combinator acceptance")).toBe("yc-acceptance");
    expect(normalizePostTopic("RELEASE NOTES")).toBe("product-update");
    expect(normalizePostTopic("not-a-real-topic")).toBeNull();
    expect(isPostTopic("traction")).toBe(true);
    expect(isPostTopic("Traction")).toBe(false);
    expect(getPostTopicDefinition("press-or-media").label).toBe("Press or Media");
    expect(normalizePostTopics(["Culture", "traction", "Growth", "bogus", "Culture"])).toEqual([
      "traction",
      "culture"
    ]);
  });
});

describe("classifyPostTopics", () => {
  it("lets valid curated topics win, normalizes them, and does not auto-append rule topics", () => {
    const result = classifyPostTopics({
      explicitTopics: ["Press", "customer-story", "Press or Media", "invalid"],
      text: "We launched today after reaching 50,000 customers."
    });

    expect(result).toMatchObject({
      topics: ["customer-win", "press-or-media"],
      classifierVersion: POST_TOPIC_CLASSIFIER_VERSION,
      taxonomyVersion: POST_TOPIC_TAXONOMY_VERSION,
      method: "curated",
      confidence: 1,
      strength: "curated"
    });
    expect(result.matches.map((match) => match.topic)).toEqual(result.topics);
    expect(result.matchedTerms).toEqual(["Customer Win", "Press or Media"]);
  });

  it("recognizes strong traction evidence but not one ambiguous business token", () => {
    const strong = classifyPostTopics({
      text: "We crossed 12,000 paid customers and grew 48% this quarter."
    });
    expect(strong.topics[0]).toBe("traction");
    expect(strong.matches[0]).toMatchObject({ topic: "traction", strength: "strong" });
    expect(strong.matches[0]?.matchedTerms.join(" ")).toMatch(/12,000 paid customers/i);

    expect(classifyPostTopics({ text: "Revenue matters to every business." }).topics).toEqual(["other"]);
    expect(classifyPostTopics({ text: "Our users inspire us every day." }).topics).toEqual(["other"]);
  });

  it("recognizes product demonstrations without treating every video as a showcase", () => {
    const demo = classifyPostTopics({
      text: "Here is how it works: watch our product demo from start to finish.",
      mediaType: "video"
    });
    expect(demo.topics).toContain("product-showcase");
    expect(demo.matches.find((match) => match.topic === "product-showcase")?.matchedTerms).toContain("media:video");

    expect(classifyPostTopics({ text: "A quick hello from the team.", mediaType: "video" }).topics).toEqual(["other"]);
  });

  it("separates launch announcements and product updates", () => {
    expect(classifyPostTopics({ text: "We're thrilled to introduce our new app, available today." }).topics)
      .toContain("product-launch");
    expect(classifyPostTopics({ text: "Product update: we've added role-based access controls." }).topics)
      .toContain("product-update");
  });

  it("requires an explicit authored YC acceptance statement", () => {
    expect(classifyPostTopics({ text: "We were accepted into Y Combinator!" }).topics).toEqual(["yc-acceptance"]);
    expect(classifyPostTopics({ text: "We're excited to join the Summer 2026 YC batch." }).topics).toEqual([
      "yc-acceptance"
    ]);
    expect(classifyPostTopics({ text: "Applications for the YC Summer 2026 batch are open." }).topics).toEqual([
      "other"
    ]);
    expect(classifyPostTopics({ text: "Congratulations to Acme, accepted into YC." }).topics).toEqual(["other"]);
    expect(classifyPostTopics({ text: "We build software and happen to be a YC company." }).topics).toEqual(["other"]);
  });

  it("recognizes vision only from specific mission, thesis, or future-state language", () => {
    expect(classifyPostTopics({ text: "Our mission is to make specialized care available to everyone." }).topics)
      .toContain("company-vision");
    expect(classifyPostTopics({ text: "We're excited about the future!" }).topics).toEqual(["other"]);
  });

  it("requires explicit comedic evidence and ignores generic excitement or an emoji", () => {
    expect(classifyPostTopics({ text: "Expectation vs. reality: our deployment meme of the week 😂" }).topics)
      .toContain("humor");
    expect(classifyPostTopics({ text: "We're thrilled and excited! 😂" }).topics).toEqual(["other"]);
  });

  it.each([
    ["customer-win", "Customer case study: Acme chose us to run its support operation."],
    ["fundraising", "We've raised $8M in our seed round."],
    ["hiring", "We're hiring — join our team as a staff engineer."],
    ["founder-story", "How I founded the company: my founder journey."],
    ["technical-deep-dive", "Engineering deep dive: how we scaled our distributed system."],
    ["open-source", "We've open-sourced the library under the MIT license."],
    ["research-or-benchmark", "Our new benchmark shares evaluation results across 12 models."],
    ["partnership", "We're proud to announce our strategic partnership with Acme."],
    ["demo-day", "We're presenting at YC Demo Day next week."],
    ["milestone", "We've reached a major company milestone: our 5th anniversary."],
    ["product-update", "Product update: a new feature is now in the changelog."],
    ["behind-the-scenes", "Behind the scenes: meet the team making our hardware."],
    ["market-insight", "Our market analysis explores the latest industry trend."],
    ["community", "Community spotlight: thank you to our community contributors."],
    ["press-or-media", "We're featured in Tech Weekly—read our interview."],
    ["awards", "We were named a finalist for the Innovation Award."],
    ["event", "Join us at the annual conference and live workshop."],
    ["culture", "Our company culture and values shape how we work."]
  ] as const)("classifies %s from adequate evidence", (topic, text) => {
    expect(classifyPostTopics({ text }).topics).toContain(topic);
  });

  it("supports deterministic multi-label classification and caps automatic output at three", () => {
    const input = {
      title: "Launch milestone",
      text: [
        "We've launched our new product, available today.",
        "Watch our product demo and walkthrough.",
        "We crossed 10,000 paid customers and grew 60%.",
        "We're hiring—join our team.",
        "Our company culture is how we work."
      ].join(" "),
      mediaType: "video" as const
    };
    const first = classifyPostTopics(input);
    const second = classifyPostTopics(input);

    expect(first).toEqual(second);
    expect(first.method).toBe("rules");
    expect(first.topics).toHaveLength(MAX_AUTOMATIC_POST_TOPICS);
    expect(first.topics).toEqual(["product-launch", "product-showcase", "traction"]);
    expect(first.matches.every((match) => match.matchedTerms.length > 0)).toBe(true);
  });

  it("extracts only visible authored fields from raw JSON and ignores metadata and engagement counts", () => {
    const rawVisibleText = JSON.stringify({
      counts: { users: 500_000, revenue: 2_000_000, likes: 90_000 },
      verification: { description: "internal verification note" },
      target: { title: "YC Summer 2026 company" },
      post: { caption: "Behind the scenes with our design team." }
    });
    expect(extractPostVisibleText(rawVisibleText)).toBe("Behind the scenes with our design team.");
    const classification = classifyPostTopics({ rawVisibleText });
    expect(classification.topics).toContain("behind-the-scenes");
    expect(classification.topics).not.toContain("traction");
    expect(classification.topics).not.toContain("yc-acceptance");
  });

  it("reads hashtags and nested visible post text, tolerates malformed JSON, and falls back to Other", () => {
    expect(classifyPostTopics({ hashtags: ["OpenSource"] }).topics).toEqual(["open-source"]);
    expect(classifyPostTopics({ rawVisibleText: JSON.stringify({ post: { raw_text: "We're hiring now." } }) }).topics)
      .toEqual(["hiring"]);
    expect(extractPostVisibleText("plain visible caption")).toBe("");
    expect(extractPostVisibleText('{"caption":')).toBe("");

    const fallback = classifyPostTopics({ text: "A calm Tuesday at the office." });
    expect(fallback).toMatchObject({
      topics: ["other"],
      method: "fallback",
      strength: "fallback",
      confidence: 0.25,
      matchedTerms: []
    });
  });
});
