import type { BusinessModel, DemoGraphDataset, Platform, ReviewState } from "./types";

const officialWebsite = "Found on the official demo website.";
const searchCandidate = "Public search candidate with YC/company context; not canonical until reviewed.";

const spring2026ExpectedCount = 197;

export const demoGraphDataset: DemoGraphDataset = {
  batches: [
    {
      slug: "S2026",
      label: "YC Spring 2026",
      companyCountExpected: spring2026ExpectedCount,
      companyCountObserved: 5
    }
  ],
  companies: [
    company({
      id: "company-ledgerloop",
      name: "LedgerLoop AI",
      tagline: "Autonomous reconciliation for finance teams",
      description: "Reads bank, ERP, and invoice data to resolve month-end exceptions with human review.",
      groupPartner: "Dana Liu",
      primaryIndustry: "fintech",
      businessModel: "b2b",
      industries: ["fintech", "ai agents", "accounting"],
      founderIds: ["founder-maya-chen", "founder-owen-park"],
      totalScore: 88,
      previousScore: 73,
      platformScores: { github: 91, linkedin: 82, web: 74 },
      socialAccounts: [
        account("acct-ledgerloop-github", "github", "ledgerloop-demo", "https://github.com/ledgerloop-demo", "verified", officialWebsite),
        account("acct-ledgerloop-linkedin", "linkedin", "ledgerloop-ai", "https://www.linkedin.com/company/ledgerloop-ai-demo", "verified", officialWebsite),
        account("acct-ledgerloop-x", "x", "ledgerloop_ai", "https://x.com/ledgerloop_ai", "needs_review", searchCandidate)
      ]
    }),
    company({
      id: "company-carewell",
      name: "Carewell Robotics",
      tagline: "In-home rehab robots for physical therapy",
      description: "Sensor-rich home devices help therapists monitor patient rehab progress.",
      groupPartner: "Dana Liu",
      primaryIndustry: "healthcare",
      businessModel: "hardware",
      industries: ["healthcare", "robotics", "remote monitoring"],
      founderIds: ["founder-sam-rivera", "founder-nina-patel"],
      totalScore: 76,
      previousScore: 77,
      platformScores: { youtube: 83, product_hunt: 71, web: 64 },
      socialAccounts: [
        account("acct-carewell-youtube", "youtube", "CarewellRobotics", "https://www.youtube.com/@CarewellRoboticsDemo", "verified", officialWebsite),
        account("acct-carewell-producthunt", "product_hunt", "carewell-robotics", "https://www.producthunt.com/products/carewell-robotics-demo", "verified", "Launch matched by product name, website, and founder context.")
      ]
    }),
    company({
      id: "company-promptforge",
      name: "PromptForge",
      tagline: "Evaluation workflows for production AI teams",
      description: "Prompt regression tests, trace review, and evaluation scorecards for AI product teams.",
      groupPartner: "Priya Shah",
      primaryIndustry: "developer tools",
      businessModel: "developer_tools",
      industries: ["developer tools", "ai infrastructure", "llm evals"],
      founderIds: ["founder-luca-martin"],
      totalScore: 69,
      previousScore: 51,
      platformScores: { github: 79, rss: 73, web: 68 },
      socialAccounts: [
        account("acct-promptforge-github", "github", "promptforge-demo", "https://github.com/promptforge-demo", "verified", officialWebsite),
        account("acct-promptforge-rss", "rss", "promptforge-blog", "https://promptforge.example.com/blog/rss.xml", "verified", officialWebsite)
      ]
    }),
    company({
      id: "company-sunspoke",
      name: "Sunspoke",
      tagline: "Neighborhood-scale solar forecasting",
      description: "Predicts solar production and grid demand for community energy operators.",
      groupPartner: null,
      primaryIndustry: "climate",
      businessModel: "b2b",
      industries: ["climate", "energy", "forecasting"],
      founderIds: ["founder-amara-ibrahim", "founder-theo-kim"],
      totalScore: 43,
      previousScore: 39,
      platformScores: { web: 58, linkedin: 37, rss: 34 },
      socialAccounts: [
        account("acct-sunspoke-web", "web", "sunspoke", "https://sunspoke.example.com/press", "verified", officialWebsite),
        account("acct-sunspoke-linkedin", "linkedin", "sunspoke-energy", "https://www.linkedin.com/company/sunspoke-demo", "needs_review", "Company name matched, but the profile has limited batch context.")
      ]
    }),
    company({
      id: "company-harborvector",
      name: "HarborVector",
      tagline: "Freight routing APIs for regional carriers",
      description: "Optimizes freight lane pricing, capacity, and routing for regional logistics teams.",
      groupPartner: "Priya Shah",
      primaryIndustry: "logistics",
      businessModel: "api",
      industries: ["logistics", "developer tools", "marketplaces"],
      founderIds: ["founder-eli-brooks"],
      totalScore: 31,
      previousScore: 29,
      platformScores: { product_hunt: 44, web: 28 },
      socialAccounts: [
        account("acct-harborvector-producthunt", "product_hunt", "harborvector", "https://www.producthunt.com/products/harborvector-demo", "rejected", "Matched by name only; rejected until an official backlink or batch context appears.")
      ]
    }),
    company({
      id: "company-orbitdesk",
      batchSlug: "W2026",
      name: "OrbitDesk",
      tagline: "AI support desk for hardware teams",
      description: "Routes warranty, repair, and field-service conversations to hardware operators.",
      groupPartner: "Noah Reed",
      primaryIndustry: "customer support",
      businessModel: "b2b",
      industries: ["customer support", "ai agents", "hardware"],
      founderIds: ["founder-jas-li"],
      totalScore: 72,
      previousScore: 70,
      platformScores: { github: 78, web: 62 },
      socialAccounts: [
        account("acct-orbitdesk-github", "github", "orbitdesk-demo", "https://github.com/orbitdesk-demo", "verified", officialWebsite)
      ]
    })
  ],
  founders: [
    founder("founder-maya-chen", "Maya Chen", "company-ledgerloop", "fintech", "b2b", 82, 70, { linkedin: 84, x: 62 }, [
      account("acct-maya-linkedin", "linkedin", "maya-chen-demo", "https://www.linkedin.com/in/maya-chen-demo", "verified", officialWebsite)
    ]),
    founder("founder-owen-park", "Owen Park", "company-ledgerloop", "fintech", "b2b", 66, 59, { github: 76, web: 41 }, [
      account("acct-owen-github", "github", "owenpark-demo", "https://github.com/owenpark-demo", "verified", officialWebsite)
    ]),
    founder("founder-sam-rivera", "Sam Rivera", "company-carewell", "healthcare", "hardware", 71, 74, { youtube: 78, linkedin: 53 }, [
      account("acct-sam-youtube", "youtube", "sam-carewell", "https://www.youtube.com/@sam-carewell-demo", "verified", officialWebsite)
    ]),
    founder("founder-nina-patel", "Nina Patel", "company-carewell", "healthcare", "hardware", 39, 35, { linkedin: 42 }, [
      account("acct-nina-linkedin", "linkedin", "nina-patel-demo", "https://www.linkedin.com/in/nina-patel-demo", "needs_review", "Name and company match, but no official website backlink was found.")
    ]),
    founder("founder-luca-martin", "Luca Martin", "company-promptforge", "developer tools", "developer_tools", 74, 52, { github: 81, rss: 68 }, [
      account("acct-luca-github", "github", "lucamartin-demo", "https://github.com/lucamartin-demo", "verified", officialWebsite)
    ]),
    founder("founder-amara-ibrahim", "Amara Ibrahim", "company-sunspoke", "climate", "b2b", 32, 29, { web: 36 }, []),
    founder("founder-theo-kim", "Theo Kim", "company-sunspoke", "climate", "b2b", 46, 45, { rss: 48, web: 40 }, [
      account("acct-theo-rss", "rss", "theo-notes", "https://theokim.example.com/feed.xml", "verified", officialWebsite)
    ]),
    founder("founder-eli-brooks", "Eli Brooks", "company-harborvector", "logistics", "api", 28, 27, { web: 30 }, []),
    founder("founder-jas-li", "Jas Li", "company-orbitdesk", "customer support", "b2b", 61, 57, { github: 68 }, [], "W2026")
  ],
  evidence: [
    evidence("evidence-ledgerloop-github-1", "company", "company-ledgerloop", "github", "LedgerLoop AI", "ledgerloop-demo", "Released an open connector pack for ERP reconciliation events with replayable test fixtures.", "repo", { stars: 412, forks: 39, issues: 12, watchers: 58 }, 92, "https://github.com/ledgerloop-demo/connectors", "High GitHub stars and forks in the selected batch percentile."),
    evidence("evidence-ledgerloop-linkedin-1", "company", "company-ledgerloop", "linkedin", "LedgerLoop AI", "ledgerloop-ai", "Shared a customer workflow showing 18 hours saved during month-end close.", "link", { likes: 820, comments: 56, shares: 38, views: 18400 }, 83, "https://www.linkedin.com/company/ledgerloop-ai-demo/posts/demo-ledgerloop-close", "Strong engagement rate for a company account and clear product relevance."),
    evidence("evidence-maya-linkedin-1", "founder", "founder-maya-chen", "linkedin", "Maya Chen", "maya-chen-demo", "Explained how finance teams validate AI-suggested accounting exceptions before posting.", "text", { likes: 1180, comments: 91, shares: 64, views: 32200 }, 88, "https://www.linkedin.com/in/maya-chen-demo/recent-activity/demo", "Founder-level post outperformed peer founder posts in the demo batch."),
    evidence("evidence-owen-github-1", "founder", "founder-owen-park", "github", "Owen Park", "owenpark-demo", "Published a reproducible benchmark harness for ledger matching models.", "repo", { stars: 143, forks: 17, issues: 4 }, 68, "https://github.com/owenpark-demo/reconciliation-bench", "Developer audience signal supports the company traction score."),
    evidence("evidence-carewell-youtube-1", "company", "company-carewell", "youtube", "Carewell Robotics", "CarewellRobotics", "Demo video of guided knee rehab with therapist review mode.", "video", { views: 52100, likes: 1900, comments: 138 }, 86, "https://www.youtube.com/watch?v=carewell-demo", "High view count plus comments in a narrow technical healthcare niche."),
    evidence("evidence-carewell-producthunt-1", "company", "company-carewell", "product_hunt", "Carewell Robotics", "carewell-robotics", "Launch page for at-home physical therapy robot kit.", "launch", { upvotes: 604, comments: 73 }, 74, "https://www.producthunt.com/posts/carewell-robotics-demo", "Product Hunt launch has above-demo-median upvotes and comments."),
    evidence("evidence-sam-youtube-1", "founder", "founder-sam-rivera", "youtube", "Sam Rivera", "sam-carewell", "Walkthrough of how therapists tune the robot assistance level.", "video", { views: 22600, likes: 830, comments: 49 }, 72, "https://www.youtube.com/watch?v=sam-carewell-demo", "Founder technical walkthrough contributed to company-level score."),
    evidence("evidence-promptforge-github-1", "company", "company-promptforge", "github", "PromptForge", "promptforge-demo", "New eval runner templates for regression testing tool calls.", "repo", { stars: 276, forks: 28, issues: 9, watchers: 31 }, 79, "https://github.com/promptforge-demo/evals", "Recent repo momentum increased the latest snapshot score."),
    evidence("evidence-promptforge-rss-1", "company", "company-promptforge", "rss", "PromptForge Blog", "promptforge-blog", "A practical guide to reducing prompt regressions before production deploys.", "link", { views: 14100, comments: 22, shares: 89 }, 70, "https://promptforge.example.com/blog/reducing-prompt-regressions", "Blog share volume is strong for developer-tool content."),
    evidence("evidence-luca-github-1", "founder", "founder-luca-martin", "github", "Luca Martin", "lucamartin-demo", "Merged a trace visualizer that maps prompt variants to failing assertions.", "repo", { stars: 191, forks: 21, issues: 6 }, 75, "https://github.com/lucamartin-demo/trace-evals", "Founder signal is directly relevant to PromptForge's product narrative."),
    evidence("evidence-sunspoke-web-1", "company", "company-sunspoke", "web", "Grid Dispatch Notes", null, "Sunspoke was mentioned in a roundup of neighborhood energy forecasting tools.", "link", { views: 8200, shares: 24 }, 49, "https://example.com/press/grid-dispatch-sunspoke", "Credible web mention, but weaker social metric coverage."),
    evidence("evidence-theo-rss-1", "founder", "founder-theo-kim", "rss", "Theo Kim", "theo-notes", "A short technical note on weather-windowed solar forecasting.", "link", { views: 3300, shares: 17 }, 44, "https://theokim.example.com/notes/weather-windowed-solar", "Relevant founder-authored evidence, modest reach."),
    evidence("evidence-harborvector-producthunt-1", "company", "company-harborvector", "product_hunt", "HarborVector", "harborvector", "API launch for regional freight lane recommendations.", "launch", { upvotes: 211, comments: 18 }, 38, "https://www.producthunt.com/posts/harborvector-demo", "Launch is valid evidence but below the batch median for Product Hunt."),
    evidence("evidence-orbitdesk-github-1", "company", "company-orbitdesk", "github", "OrbitDesk", "orbitdesk-demo", "Published a hardware-support ticket classifier with anonymized examples.", "repo", { stars: 238, forks: 23, issues: 8 }, 76, "https://github.com/orbitdesk-demo/hardware-support-classifier", "Strong GitHub evidence for W2026 demo mode.")
  ],
  platformStatus: [
    { platform: "github", status: "working", authMethod: "GitHub CLI or token", notes: "Local workstation has gh auth. App connectors remain read-only." },
    { platform: "web", status: "working", authMethod: "Public fetch / reader", notes: "Public webpages only. No paywall or access-control bypass." },
    { platform: "rss", status: "working", authMethod: "Public feed fetch", notes: "Public feeds only." },
    { platform: "youtube", status: "working", authMethod: "yt-dlp or public metadata", notes: "Public metadata and transcripts where available." },
    { platform: "product_hunt", status: "needs_config", authMethod: "Public web/search connector", notes: "Public pages can be matched; API integration is future work." },
    { platform: "x", status: "needs_config", authMethod: "Official API preferred", notes: "Browser automation is disabled by default and explicit-per-task only." },
    { platform: "linkedin", status: "risky", authMethod: "Manual/public or approved official access", notes: "Avoid logged-in automation unless explicitly approved for a one-off read-only task." },
    { platform: "instagram", status: "public_only", authMethod: "Unauthenticated public pages", notes: "No login/session automation. No saved posts, DMs, likes, comments, or private data." },
    { platform: "reddit", status: "needs_config", authMethod: "Official Reddit API via PRAW", notes: "Prefer official read-only API credentials for searches and posts." },
    { platform: "bilibili", status: "needs_config", authMethod: "Public search now; subtitles require explicit setup", notes: "No account automation unless approved for a specific read-only test." }
  ]
};

type CompanyInput = Omit<DemoGraphDataset["companies"][number], "batchSlug" | "ycProfileUrl" | "websiteUrl" | "review_state" | "sourceUrl"> & {
  batchSlug?: string;
};

function company(input: CompanyInput): DemoGraphDataset["companies"][number] {
  const slug = input.batchSlug ?? "S2026";
  return {
    ...input,
    batchSlug: slug,
    ycProfileUrl: `https://example.com/yc/${slug.toLowerCase()}/${input.id.replace(/^company-/, "")}`,
    websiteUrl: `https://${input.id.replace(/^company-/, "")}.example.com`,
    review_state: "verified",
    sourceUrl: `https://www.ycombinator.com/companies?batch=${slug}`
  };
}

function founder(
  id: string,
  name: string,
  companyId: string,
  primaryIndustry: string,
  businessModel: BusinessModel,
  totalScore: number,
  previousScore: number,
  platformScores: DemoGraphDataset["founders"][number]["platformScores"],
  socialAccounts: DemoGraphDataset["founders"][number]["socialAccounts"],
  batchSlug = "S2026"
): DemoGraphDataset["founders"][number] {
  return {
    id,
    batchSlug,
    name,
    ycProfileUrl: `https://example.com/yc/founders/${id.replace(/^founder-/, "")}`,
    personalWebsiteUrl: null,
    primaryIndustry,
    businessModel,
    review_state: "verified",
    sourceUrl: `https://www.ycombinator.com/companies?batch=${batchSlug}`,
    companyIds: [companyId],
    socialAccounts,
    totalScore,
    previousScore,
    platformScores
  };
}

function account(
  id: string,
  platform: Platform,
  handle: string,
  url: string,
  reviewState: ReviewState,
  matchReason: string
): DemoGraphDataset["companies"][number]["socialAccounts"][number] {
  return {
    id,
    platform,
    handle,
    url,
    review_state: reviewState,
    discoveredFromUrl: reviewState === "verified" ? "https://example.com/official-source" : null,
    matchReason
  };
}

function evidence(
  id: string,
  entityType: "company" | "founder",
  entityId: string,
  platform: Platform,
  authorName: string,
  authorHandle: string | null,
  text: string,
  mediaType: DemoGraphDataset["evidence"][number]["mediaType"],
  metrics: DemoGraphDataset["evidence"][number]["metrics"],
  contributionScore: number,
  sourceUrl: string,
  why: string
): DemoGraphDataset["evidence"][number] {
  return {
    id,
    entityType,
    entityId,
    platform,
    authorName,
    authorHandle,
    postedAt: "2026-06-20T16:24:00.000Z",
    text,
    mediaType,
    metrics,
    contributionScore,
    sourceUrl,
    why
  };
}
