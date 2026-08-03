import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "@/lib/graph/types";
import {
  classifySourceDeterministically,
  timelineClassificationSourceFromGraphEvidence,
} from "@/lib/timeline/classification";
import { clusterTimelineEvents, shouldMergeTimelineEvents } from "@/lib/timeline/dedupe";
import { calculateTimelineImportance } from "@/lib/timeline/importance";
import type {
  TimelineClassificationInput,
  TimelineClassificationSource,
} from "@/lib/timeline/domain";

const company = {
  id: "company-graphify-labs",
  slug: "graphify-labs",
  name: "Graphify Labs",
  aliases: ["Graphify Labs", "Graphify"],
  websiteUrl: "https://graphify.com",
  founderNames: ["Safi Shamsi"],
};

describe("timeline graph evidence adaptation", () => {
  it("uses the title when a canonical video has no text body", () => {
    const source = timelineClassificationSourceFromGraphEvidence({
      id: "ev-title-only-video",
      entityType: "company",
      platform: "youtube",
      sourceUrl: "https://youtube.com/watch?v=title-only",
      title: "Title-only canonical video",
      text: null,
      authorHandle: "example",
      authorName: "Example",
      postedAt: "2026-08-01T12:00:00.000Z",
      publishedAtPrecision: "exact",
      review_state: "verified",
      linkStatus: "verified",
      topics: [],
    } as unknown as EvidenceItem);

    expect(source.text).toBe("Title-only canonical video");
    expect(source.evidenceExcerpt).toBe("Title-only canonical video");
  });
});

describe("timeline deterministic publication gating", () => {
  it.each([
    "Race is on to become the first Indian developer to ship a 100k-star repo. Currently on track with @graphify to hit 100k stars.",
    "3 months since we opensourcemaxxed Graphify. Here's what happened: Hit 82k GitHub stars and 2.8M downloads.",
    "As Gabriel mentioned, distribution is the hardest part for any product. We just hit a new record with 66.8k downloads in one day.",
    "Yesterday was our biggest day on the open source side so far. We crossed 52k downloads in a single day.",
    "Say no more, I just set it up for you. We’ve hit 73k GitHub stars and 2.2M downloads.",
  ])("does not turn Graphify chatter or retrospective metrics into a milestone: %s", (text) => {
    const result = classify({ company, source: source({ text, title: text }) });
    expect(result.isMeaningfulEvent).toBe(false);
  });

  it("publishes a direct achieved milestone with a neutral company-specific title", () => {
    const text = "We’ve reached almost 200 developers in Graphify Labs just one week after launching the Discord server.";
    const result = classify({ company, source: source({ text, title: text }) });
    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      category: "traction_milestone",
      title: "Graphify Labs reported almost 200 developers",
    });
  });

  it("classifies an announced quantified raise as funding instead of a product launch", () => {
    const text = "Announcing our $2.5m raise led by @TheVRFund and @speedrun!";
    const result = classify({
      company: {
        id: "a16z-speedrun-006-oasiz",
        slug: "oasiz",
        name: "Oasiz",
        aliases: ["Oasiz", "playoasiz"],
        websiteUrl: "https://oasiz.gg",
        founderNames: ["Abel Dagne"],
      },
      source: source({
        text,
        title: text,
        publisher: "playoasiz",
        authorRelationship: "company",
      }),
    });

    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      category: "funding",
      title: "Oasiz announced $2.5m funding round",
      isMajor: true,
    });
  });

  it.each([
    "i am being shipped",
    "i got shipped",
    "Introducing @heyclicky teammate #1. Welcome, Nilesh. I'm hiring.",
    "It's the 1-year anniversary of this app. Introducing freewrite video logging.",
  ])("rejects non-product HeyClicky activity: %s", (text) => {
    const result = classify({
      company: heyClicky,
      source: source({ text, title: text, authorRelationship: "company", publisher: "heyclicky" }),
    });
    expect(result.isMeaningfulEvent).toBe(false);
  });

  it("rejects an unrelated founder product even when its topic says product launch", () => {
    const text = "introducing makesomething, a place to learn ai.";
    const result = classify({
      company: heyClicky,
      source: source({ text, title: text, topic: "product-launch", authorRelationship: "founder", linkStatus: "unchecked" }),
    });
    expect(result.isMeaningfulEvent).toBe(false);
  });

  it("accepts a verified direct founder feature release without duplicating title and body", () => {
    const text = "Today we're shipping screen-aware dictation. First, we built speedy speech-to-text.";
    const result = classify({
      company: heyClicky,
      source: source({
        text,
        title: `${text}\n\n${text}`,
        authorRelationship: "founder",
        linkStatus: "verified",
      }),
    });
    expect(result).toMatchObject({ isMeaningfulEvent: true, category: "product_launch" });
    if (result.isMeaningfulEvent) {
      expect(result.title).toBe("HeyClicky released screen-aware dictation");
      expect(result.title.length).toBeLessThanOrEqual(140);
      expect(result.title).not.toMatch(/screen-aware dictation.*screen-aware dictation/i);
    }
  });

  it("decodes source text entities before publishing a human-readable title", () => {
    const result = classify({
      company: { ...heyClicky, name: "Drafted", aliases: ["Drafted"] },
      source: source({
        text: "We released Projects &amp; Tasks today.",
        title: "We released Projects &amp; Tasks today.",
        authorRelationship: "company",
        publisher: "Drafted",
      }),
    });
    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      title: "Drafted released Projects & Tasks",
    });
  });

  it.each([
    ["We just shipped 3 new graphs powered by Dither Kit.", "Drafted released 3 new graphs"],
    ["Introducing DraftedAI. It lets you create safe database clones.", "Drafted released DraftedAI"],
  ])("keeps extracted product names concise: %s", (text, title) => {
    const result = classify({
      company: { ...heyClicky, name: "Drafted", aliases: ["Drafted"] },
      source: source({ text, title: text, authorRelationship: "company", publisher: "Drafted" }),
    });
    expect(result).toMatchObject({ isMeaningfulEvent: true, title });
  });

  it("treats an official launch video as direct dated launch evidence", () => {
    const result = classify({
      company: heyClicky,
      source: source({
        text: "HeyClicky Launch Video",
        title: "HeyClicky Launch Video",
        sourceType: "video",
        authorRelationship: "company",
        publisher: "heyclicky",
      }),
    });
    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      category: "product_launch",
      title: "HeyClicky announced its public launch",
      summary: "HeyClicky announced its public launch in a dated company video.",
    });
  });

  it("uses a product named by a launch video without publishing the source label", () => {
    const result = classify({
      company: { ...heyClicky, id: "company-nebula", slug: "nebula", name: "Nebula Security", aliases: ["Nebula Security"] },
      source: source({
        text: "Vega Launch Video",
        title: "Vega Launch Video",
        sourceType: "video",
        authorRelationship: "company",
        publisher: "Nebula Security",
      }),
    });
    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      title: "Nebula Security launched Vega",
      summary: "Nebula Security introduced Vega in a dated launch video.",
    });
  });

  it("distinguishes a named Product Hunt launch from the root product", () => {
    const identity = { ...heyClicky, id: "company-insforge", slug: "insforge", name: "InsForge", aliases: ["InsForge"] };
    const root = classify({
      company: identity,
      source: source({
        id: "insforge-root",
        url: "https://producthunt.com/products/insforge-alpha/launches/insforge-3",
        text: "InsForge - Give agents everything they need to ship fullstack apps.",
        title: "InsForge - Give agents everything they need to ship fullstack apps",
        sourceType: "product_hunt",
        authorRelationship: "company",
        publisher: "InsForge",
      }),
    });
    const branching = classify({
      company: identity,
      source: source({
        id: "insforge-branching",
        url: "https://producthunt.com/products/insforge-alpha/launches/insforge-backend-branching",
        text: "InsForge Backend Branching launched on Product Hunt.",
        title: "InsForge Backend Branching",
        sourceType: "product_hunt",
        authorRelationship: "company",
        publisher: "InsForge",
      }),
    });
    expect(root).toMatchObject({ isMeaningfulEvent: true, title: "InsForge launched on Product Hunt" });
    expect(branching).toMatchObject({ isMeaningfulEvent: true, title: "InsForge launched Backend Branching on Product Hunt" });
  });

  it("classifies Avea's later Sentinel quality shipment as an update, not another launch", () => {
    const result = classify({
      company: { ...heyClicky, id: "company-avea", slug: "avea", name: "Avea Robotics", aliases: ["Avea Robotics", "Avea"] },
      source: source({
        text: "We just shipped a crazy update to Sentinel- we doubled the quality of video without affecting latency.",
        title: "We just shipped a crazy update to Sentinel",
        authorRelationship: "founder",
        publisher: "Avea Robotics founder",
      }),
    });
    expect(result).toMatchObject({ isMeaningfulEvent: true, category: "product_update" });
  });

  it("requires exact source dates", () => {
    const result = classify({
      company,
      source: source({
        text: "Graphify Labs raised a $5M seed round.",
        title: "Graphify Labs raised a $5M seed round.",
        publicationTimestamp: null,
        publicationDatePrecision: "unknown",
      }),
    });
    expect(result).toMatchObject({ isMeaningfulEvent: false, reason: "exact_date_unsupported" });
  });

  it("does not attribute a third-party funding claim to the posting company", () => {
    const text = "The actual race in robotics isn't the hardware 1X raised $100M, Tesla is scaling Optimus.";
    const result = classify({
      company: {
        id: "company-hub",
        slug: "hub",
        name: "Hub",
        aliases: ["Hub"],
        websiteUrl: "https://usehub.ai",
        founderNames: [],
      },
      source: source({
        text,
        title: text,
        publisher: "Hub",
        authorRelationship: "company",
        topic: "corporate-update",
      }),
    });
    expect(result).toMatchObject({ isMeaningfulEvent: false, reason: "company_match_uncertain" });
  });

  it("does not attribute a third-party product release to the posting company", () => {
    const text = "OpenAI launched GPT-6 today.";
    const result = classify({
      company: heyClicky,
      source: source({ text, title: text, publisher: "heyclicky", authorRelationship: "company" }),
    });
    expect(result).toMatchObject({ isMeaningfulEvent: false, reason: "company_match_uncertain" });
  });

  it("does not match a short company name as a substring of another claimant", () => {
    const text = "Paragon raised a $12M seed round to expand its product.";
    const result = classify({
      company: {
        id: "company-ara",
        slug: "ara",
        name: "Ara",
        aliases: ["Ara"],
        websiteUrl: "https://ara.example",
        founderNames: [],
      },
      source: source({
        text,
        title: text,
        publisher: "Example News",
        sourceType: "news_article",
        authorRelationship: "third_party",
      }),
    });
    expect(result).toMatchObject({ isMeaningfulEvent: false, reason: "company_match_uncertain" });
  });
});

describe("timeline clustering and importance", () => {
  it("clusters two direct sources for one real launch and retains both members", () => {
    const events = ["company-post", "product-hunt"].map((sourceId) => ({
      id: sourceId,
      companyId: "company-demo",
      category: "product_launch" as const,
      eventDate: "2026-06-10",
      title: "Demo released version 1.0",
      sourceIds: [sourceId],
    }));
    expect(clusterTimelineEvents(events)).toEqual([events]);
  });

  it("merges generic launch-video and public-launch labels for one dated launch", () => {
    expect(shouldMergeTimelineEvents({
      companyId: "company-demo",
      category: "product_launch",
      eventDate: "2026-06-10",
      title: "Demo published its launch video",
    }, {
      companyId: "company-demo",
      category: "product_launch",
      eventDate: "2026-06-11",
      title: "Demo announced its public launch",
    })).toBe(true);
  });

  it.each([
    ["Ara", "2026-05-31", "Ara released Autosuggest", "2026-06-01", "Ara released AraBrowser"],
    ["InsForge", "2026-07-15", "InsForge launched on Product Hunt", "2026-07-15", "InsForge launched Backend Branching on Product Hunt"],
    ["BentoLabs AI", "2026-06-01", "BentoLabs AI announced its public launch", "2026-06-15", "BentoLabs AI released Issues"],
  ])("does not merge %s root or named-product events with a different named product", (companyName, leftDate, leftTitle, rightDate, rightTitle) => {
    expect(shouldMergeTimelineEvents({
      companyId: `company-${companyName.toLowerCase().replace(/\W+/g, "-")}`,
      category: "product_launch",
      eventDate: leftDate,
      title: leftTitle,
    }, {
      companyId: `company-${companyName.toLowerCase().replace(/\W+/g, "-")}`,
      category: "product_launch",
      eventDate: rightDate,
      title: rightTitle,
    })).toBe(false);
  });

  it("requires every member to match before admitting a transitive bridge into a cluster", () => {
    const root = {
      id: "bento-root", companyId: "company-bento", category: "product_launch" as const,
      eventDate: "2026-05-31", title: "BentoLabs AI announced its public launch", sourceIds: ["root-source"],
    };
    const bridge = {
      id: "bento-bridge", companyId: "company-bento", category: "product_launch" as const,
      eventDate: "2026-06-01", title: "BentoLabs AI launched on Y Combinator", sourceIds: ["root-source", "issues-source"],
    };
    const issues = {
      id: "bento-issues", companyId: "company-bento", category: "product_launch" as const,
      eventDate: "2026-06-15", title: "BentoLabs AI released Issues", sourceIds: ["issues-source"],
    };
    expect(shouldMergeTimelineEvents(root, bridge)).toBe(true);
    expect(shouldMergeTimelineEvents(bridge, issues)).toBe(true);
    expect(shouldMergeTimelineEvents(root, issues)).toBe(false);
    expect(clusterTimelineEvents([root, bridge, issues]).map((cluster) => cluster.map((event) => event.id)))
      .toEqual([["bento-root", "bento-bridge"], ["bento-issues"]]);
  });

  it.each([
    ["Runtime released We just launched Runtime", "2026-04-14", "Runtime launched on Hacker News", "2026-05-21"],
    ["Superset announced its public launch", "2026-04-07", "Superset launched on Hacker News", "2026-05-22"],
    ["Hyper released we just launched hyper", "2026-05-11", "Hyper launched on Hacker News", "2026-06-03"],
    ["transload launched on Y Combinator", "2026-05-18", "transload launched on Hacker News", "2026-06-09"],
  ])("merges a true root-product launch syndication beyond 14 days", (leftTitle, leftDate, rightTitle, rightDate) => {
    expect(shouldMergeTimelineEvents({
      companyId: "company-root-product",
      category: "product_launch",
      eventDate: leftDate,
      title: leftTitle,
    }, {
      companyId: "company-root-product",
      category: "product_launch",
      eventDate: rightDate,
      title: rightTitle,
    })).toBe(true);
  });

  it("uses a shared canonical source URL as a strong duplicate identity", () => {
    expect(shouldMergeTimelineEvents({
      companyId: "company-demo", category: "product_launch", eventDate: "2026-01-01",
      title: "Demo released Alpha", sourceUrls: ["https://www.example.com/launch?utm_source=x"],
    }, {
      companyId: "company-demo", category: "product_launch", eventDate: "2026-07-01",
      title: "Demo announced Alpha", sourceUrls: ["https://example.com/launch"],
    })).toBe(true);
  });

  it("does not merge materially different recurring milestones", () => {
    expect(shouldMergeTimelineEvents({
      companyId: "company-demo",
      category: "user_milestone",
      eventDate: "2026-06-10",
      title: "Demo reached 10,000 users",
    }, {
      companyId: "company-demo",
      category: "user_milestone",
      eventDate: "2026-06-11",
      title: "Demo reached 25,000 users",
    })).toBe(false);
  });

  it("does not make every tier-one launch major or use engagement/recency", () => {
    const input = { category: "product_launch" as const, sourceQualityTier: 1 as const };
    expect(calculateTimelineImportance(input)).toMatchObject({ score: 80, isMajor: false });
    expect(calculateTimelineImportance({ ...input, firstOfKind: true })).toMatchObject({ isMajor: true });
    expect(calculateTimelineImportance({ category: "funding", sourceQualityTier: 1 })).toMatchObject({ isMajor: true });
    expect(Object.keys(input)).toEqual(["category", "sourceQualityTier"]);
  });
});

describe("timeline direct-source conflict preservation", () => {
  it("preserves conflicting funding amounts without mistaking publication dates for occurrence conflicts", () => {
    const first = source({
      id: "funding-tier-one",
      text: "Graphify Labs raised a $5M seed round.",
      title: "Graphify Labs raised a $5M seed round.",
      publicationTimestamp: "2026-08-02T12:00:00.000Z",
      sourceQualityTier: 1,
    });
    const second = source({
      id: "funding-tier-two",
      url: "https://news.example/graphify-round",
      text: "Graphify Labs raised a $7M seed round.",
      title: "Graphify Labs raised a $7M seed round.",
      publicationTimestamp: "2026-08-03T12:00:00.000Z",
      sourceQualityTier: 2,
      sourceType: "news_article",
      publisher: "Example News",
      authorRelationship: "third_party",
    });

    const result = classifySourceDeterministically({
      company,
      sources: [first, second],
      existingEventKeys: [],
    }, first);

    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      eventDate: "2026-08-02",
      sourceIds: ["funding-tier-one", "funding-tier-two"],
    });
    if (!result.isMeaningfulEvent) throw new Error("Expected a conflict-preserving candidate.");
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["funding_amount"]);
    expect(result.conflicts.find((conflict) => conflict.field === "funding_amount")?.claims)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceId: "funding-tier-one", value: "$5M" }),
        expect.objectContaining({ sourceId: "funding-tier-two", value: "$7M" }),
      ]));
    expect(result.evidence.map((claim) => claim.sourceId)).toEqual(["funding-tier-one", "funding-tier-two"]);
  });

  it("treats the same funding claim published on different days as supporting evidence, not a date conflict", () => {
    const first = source({
      id: "same-round-primary",
      text: "Graphify Labs raised a $5M seed round.",
      title: "Graphify Labs raised a $5M seed round.",
      publicationTimestamp: "2026-08-02T12:00:00.000Z",
    });
    const laterArticle = source({
      id: "same-round-later-article",
      url: "https://news.example/graphify-round-later",
      text: "Graphify Labs raised a $5M seed round.",
      title: "Graphify Labs raised a $5M seed round.",
      publicationTimestamp: "2026-08-06T12:00:00.000Z",
      sourceQualityTier: 2,
      sourceType: "news_article",
      publisher: "Example News",
      authorRelationship: "third_party",
    });
    const result = classifySourceDeterministically({ company, sources: [first, laterArticle], existingEventKeys: [] }, first);
    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      sourceIds: ["same-round-primary", "same-round-later-article"],
      conflicts: [],
    });
  });

  it("preserves conflicting traction magnitudes", () => {
    const first = source({
      id: "traction-one",
      text: "We reached 200 developers at Graphify Labs.",
      title: "We reached 200 developers at Graphify Labs.",
    });
    const second = source({
      id: "traction-two",
      url: "https://graphify.com/blog/community",
      text: "We reached 250 developers at Graphify Labs.",
      title: "We reached 250 developers at Graphify Labs.",
      sourceType: "company_blog",
      publisher: "Graphify Labs",
      authorRelationship: "company",
    });
    const result = classifySourceDeterministically({ company, sources: [first, second], existingEventKeys: [] }, first);
    expect(result.isMeaningfulEvent).toBe(true);
    if (result.isMeaningfulEvent) {
      expect(result.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: "traction_milestone", selectedValue: "200 developers" }),
      ]));
    }
  });

  it("keeps recurring traction milestones on different days as distinct events", () => {
    const first = source({
      id: "traction-100",
      text: "We reached 100 developers at Graphify Labs.",
      title: "We reached 100 developers at Graphify Labs.",
      publicationTimestamp: "2026-08-01T12:00:00.000Z",
    });
    const second = source({
      id: "traction-200",
      url: "https://graphify.com/blog/200-developers",
      text: "We reached 200 developers at Graphify Labs.",
      title: "We reached 200 developers at Graphify Labs.",
      publicationTimestamp: "2026-08-02T12:00:00.000Z",
      sourceType: "company_blog",
      publisher: "Graphify Labs",
      authorRelationship: "company",
    });

    expect(classifySourceDeterministically({ company, sources: [first, second], existingEventKeys: [] }, first))
      .toMatchObject({ isMeaningfulEvent: true, sourceIds: ["traction-100"], conflicts: [] });
    expect(classifySourceDeterministically({ company, sources: [first, second], existingEventKeys: [] }, second))
      .toMatchObject({ isMeaningfulEvent: true, sourceIds: ["traction-200"], conflicts: [] });
  });

  it("does not combine distinct funding rounds into one conflict candidate", () => {
    const seed = source({ id: "seed", text: "Graphify Labs raised a $5M seed round.", title: "Graphify Labs raised a $5M seed round." });
    const seriesA = source({ id: "series-a", text: "Graphify Labs raised a $20M Series A round.", title: "Graphify Labs raised a $20M Series A round." });
    const result = classifySourceDeterministically({ company, sources: [seed, seriesA], existingEventKeys: [] }, seed);
    expect(result).toMatchObject({ isMeaningfulEvent: true, sourceIds: ["seed"], conflicts: [] });
  });
});

const heyClicky = {
  id: "company-heyclicky",
  slug: "heyclicky",
  name: "HeyClicky",
  aliases: ["HeyClicky"],
  websiteUrl: "https://heyclicky.com",
  founderNames: ["Farza Majeed"],
};

function classify({
  company: identity,
  source: item,
}: {
  company: TimelineClassificationInput["company"];
  source: TimelineClassificationSource;
}) {
  return classifySourceDeterministically({ company: identity, sources: [item], existingEventKeys: [] }, item);
}

function source(overrides: Partial<TimelineClassificationSource>): TimelineClassificationSource {
  return {
    id: "source-1",
    url: "https://x.com/example/status/1",
    title: null,
    publisher: "Safi Shamsi",
    sourceType: "founder_post",
    platform: "x",
    publicationTimestamp: "2026-07-10T12:00:00.000Z",
    publicationDatePrecision: "exact",
    text: "",
    evidenceExcerpt: overrides.text ?? "Direct public evidence.",
    sourceQualityTier: 1,
    attributionStatus: "verified",
    linkStatus: "verified",
    topic: "company-vision-founder-perspective",
    authorRelationship: "founder",
    ...overrides,
  };
}
