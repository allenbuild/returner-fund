import type { DashboardCandidate, DashboardMetrics } from "./contracts";

/**
 * Deterministic development/test coverage for the worker-side story pipeline.
 * These invented examples are never imported by a public request path or
 * written to the published dashboard artifact.
 */
export function developmentDashboardFixtures(now = new Date()): DashboardCandidate[] {
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 60 * 60 * 1_000).toISOString();
  const history = (hoursAgo: number, before: DashboardMetrics, after: DashboardMetrics) => [
    { observedAt: at(hoursAgo + 2), metrics: before },
    { observedAt: at(hoursAgo), metrics: after }
  ];
  const atlas = {
    trackedEntity: { companyId: "fixture-atlas", name: "Atlas Compute", cohortLabel: "YC S26", batchSlug: "S26" },
    entityKeys: ["company:fixture-atlas", "product:atlas-runtime"],
    storyKey: "atlas-runtime-launch"
  };

  return [
    // One announcement represented by six independently surfaced sources.
    candidate("atlas-x", "x", "post", "Atlas Compute launches Atlas Runtime for long-running agents", at(2), {
      ...atlas, url: "https://example.test/atlas/x", destinationUrl: "https://atlas.example/runtime", metrics: { likes: 5_400, reposts: 910, views: 420_000 }, accountBaseline: { likes: 120, views: 8_000 }, thumbnailUrl: "https://images.example.test/atlas-runtime.jpg", metricHistory: history(2, { likes: 2_200, views: 160_000 }, { likes: 5_400, reposts: 910, views: 420_000 })
    }),
    candidate("atlas-linkedin", "linkedin", "post", "Atlas Runtime is now available for agent teams", at(2.3), {
      ...atlas, url: "https://example.test/atlas/linkedin", destinationUrl: "https://atlas.example/runtime", metrics: { reactions: 2_800, comments: 220 }, accountBaseline: { reactions: 200 }, thumbnailUrl: "https://images.example.test/atlas-product.jpg"
    }),
    candidate("atlas-youtube", "youtube", "video", "A demo of Atlas Runtime orchestration", at(1.8), {
      ...atlas, url: "https://example.test/atlas/youtube", destinationUrl: "https://atlas.example/runtime", metrics: { views: 84_000, likes: 3_200, comments: 300 }, thumbnailUrl: "https://images.example.test/atlas-video.jpg", metricHistory: history(1.8, { views: 22_000, likes: 900 }, { views: 84_000, likes: 3_200, comments: 300 })
    }),
    candidate("atlas-hn", "hacker_news", "discussion", "Show HN: Atlas Runtime", at(1.7), {
      ...atlas, url: "https://news.ycombinator.com/item?id=fixture-atlas", destinationUrl: "https://atlas.example/runtime", metrics: { upvotes: 488, comments: 169 }, independentlyReported: true, thumbnailUrl: null
    }),
    candidate("atlas-reddit", "reddit", "discussion", "Atlas Runtime agent orchestration discussion", at(1.6), {
      ...atlas, url: "https://reddit.com/r/MachineLearning/comments/fixture-atlas", destinationUrl: "https://atlas.example/runtime", metrics: { upvotes: 2_140, comments: 305 }, independentlyReported: true
    }),
    candidate("atlas-news", "web", "article", "Atlas launches a runtime for long-running AI agents", at(1.4), {
      ...atlas, url: "https://news.example.test/atlas-runtime", destinationUrl: "https://atlas.example/runtime", metrics: { views: 60_000 }, independentlyReported: true, publisher: "Fixture Tech", thumbnailUrl: "https://images.example.test/atlas-article.jpg"
    }),

    // A small founder greatly outperforming their own normal baseline.
    candidate("small-founder", "x", "post", "Small founder shares a viral inference-cost breakdown", at(3), {
      url: "https://x.example.test/small-founder", metrics: { likes: 5_000, reposts: 740 }, accountBaseline: { likes: 100, reposts: 12 }, followerCount: 11_000, entityKeys: ["person:maya-li"], entityLabel: "Maya Li", topics: ["ai", "startups"], metricHistory: history(3, { likes: 900 }, { likes: 5_000, reposts: 740 })
    }),
    // A much larger account with ordinary performance.
    candidate("large-account", "x", "post", "Large account discusses this week in AI", at(2.7), {
      url: "https://x.example.test/large-account", metrics: { likes: 10_000 }, accountBaseline: { likes: 50_000 }, followerCount: 4_200_000, entityKeys: ["person:large-account"], topics: ["ai"]
    }),

    // Research qualifies because it has actual independent attention, not just publication.
    candidate("paper", "research", "paper", "Vector Labs publishes a paper on visual world models", at(6), {
      url: "https://arxiv.org/abs/fixture", destinationUrl: "https://arxiv.org/abs/fixture", metrics: { downloads: 12_000 }, entityKeys: ["paper:vector-world-models"], topics: ["research", "ai", "robotics"], thumbnailUrl: "https://images.example.test/vector-paper.png", sourceQuality: 88
    }),
    candidate("paper-hn", "hacker_news", "discussion", "HN discusses Vector Labs' visual world-model paper", at(5.3), {
      url: "https://news.ycombinator.com/item?id=fixture-paper", destinationUrl: "https://arxiv.org/abs/fixture", metrics: { upvotes: 392, comments: 144 }, independentlyReported: true, entityKeys: ["paper:vector-world-models"], topics: ["research", "ai", "robotics"]
    }),

    candidate("reddit-driven", "reddit", "discussion", "Developers debate the fastest-rising open-source coding agent", at(4), {
      url: "https://reddit.com/r/LocalLLaMA/comments/fixture-agent", metrics: { upvotes: 4_800, comments: 814 }, independentlyReported: true, entityKeys: ["project:forge-agent"], topics: ["ai", "open_source"], metricHistory: history(4, { upvotes: 1_000, comments: 220 }, { upvotes: 4_800, comments: 814 })
    }),
    candidate("youtube-driven", "youtube", "video", "Robotics team demonstrates a warehouse manipulation system", at(4.5), {
      url: "https://youtube.com/watch?v=fixture-robot", metrics: { views: 180_000, likes: 8_200, comments: 900 }, entityKeys: ["project:harbor-robot"], topics: ["robotics", "ai"], thumbnailUrl: "https://images.example.test/robot-demo.jpg", metricHistory: history(4.5, { views: 70_000, likes: 3_000 }, { views: 180_000, likes: 8_200, comments: 900 })
    }),
    candidate("viral-article", "web", "article", "A report details a major developer-tools acquisition", at(7), {
      url: "https://news.example.test/acquisition", metrics: { views: 280_000 }, independentlyReported: true, entityKeys: ["event:developer-tools-acquisition"], topics: ["startups"], thumbnailUrl: "https://images.example.test/acquisition.jpg", publisher: "Fixture Journal"
    }),

    // Two genuinely different same-company events must remain separate.
    candidate("atlas-open-source", "github", "release", "Atlas Compute open-sources its evaluation toolkit", at(9), {
      ...atlas, storyKey: "atlas-evaluation-toolkit", url: "https://github.com/atlas/eval-kit/releases/fixture", metrics: { stars: 4_200, forks: 520 }, topics: ["open_source", "ai"], thumbnailUrl: "https://images.example.test/atlas-repo.jpg"
    }),
    candidate("biotech", "web", "article", "Biotech startup reports a new protein-design collaboration", at(10), {
      url: "https://news.example.test/biotech", metrics: { views: 42_000 }, independentlyReported: true, entityKeys: ["company:bioforge"], topics: ["biotech", "startups"], thumbnailUrl: "https://images.example.test/biotech.jpg"
    })
  ];
}

function candidate(
  id: string,
  platform: DashboardCandidate["platform"],
  sourceKind: DashboardCandidate["sourceKind"],
  title: string,
  publishedAt: string,
  extra: Omit<DashboardCandidate, "id" | "canonicalKey" | "platform" | "sourceKind" | "title" | "publishedAt">
): DashboardCandidate {
  return {
    id,
    canonicalKey: `${platform}:${id}`,
    platform,
    sourceKind,
    title,
    summary: `${title}.`,
    publishedAt,
    observedAt: publishedAt,
    ...extra
  };
}
