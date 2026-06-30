import type {
  Batch,
  Company,
  CompanyFounder,
  EvidenceItem,
  Founder,
  NeedsReviewItem,
  NormalizedPost,
  PostMetrics,
  SocialAccount
} from "@/types/domain";

const now = new Date("2026-06-27T18:00:00.000Z").toISOString();

export const demoBatch: Batch = {
  id: "batch-s2026",
  slug: "S2026",
  label: "YC Spring 2026"
};

export const demoCompanies: Company[] = [
  {
    id: "company-orbitgrid",
    batchId: demoBatch.id,
    ycProfileUrl: "https://www.ycombinator.com/companies/orbitgrid",
    name: "OrbitGrid",
    websiteUrl: "https://orbitgrid.example",
    tagline: "Autonomous dispatch for distributed energy fleets",
    description:
      "OrbitGrid coordinates batteries, EV chargers, and solar assets for commercial buildings.",
    groupPartner: "Publicly Unknown",
    review_state: "verified",
    industries: ["Energy", "Climate", "AI"]
  },
  {
    id: "company-cliniclens",
    batchId: demoBatch.id,
    ycProfileUrl: "https://www.ycombinator.com/companies/cliniclens",
    name: "ClinicLens",
    websiteUrl: "https://cliniclens.example",
    tagline: "Patient operations intelligence for specialty clinics",
    description:
      "ClinicLens connects intake, scheduling, and outcomes data for high-throughput healthcare teams.",
    groupPartner: null,
    review_state: "verified",
    industries: ["Healthcare", "Operations", "AI"]
  },
  {
    id: "company-ledgerloop",
    batchId: demoBatch.id,
    ycProfileUrl: "https://www.ycombinator.com/companies/ledgerloop",
    name: "LedgerLoop",
    websiteUrl: "https://ledgerloop.example",
    tagline: "Continuous reconciliation for marketplace finance teams",
    description:
      "LedgerLoop monitors payments, payouts, and settlement mismatches across marketplace rails.",
    groupPartner: "Publicly Unknown",
    review_state: "verified",
    industries: ["Fintech", "Developer Tools", "AI"]
  },
  {
    id: "company-synthforge",
    batchId: demoBatch.id,
    ycProfileUrl: "https://www.ycombinator.com/companies/synthforge",
    name: "SynthForge",
    websiteUrl: "https://synthforge.example",
    tagline: "Synthetic eval suites for AI product teams",
    description:
      "SynthForge creates scenario-based evals, regressions, and QA traces for AI application releases.",
    groupPartner: null,
    review_state: "verified",
    industries: ["AI", "Developer Tools", "Testing"]
  }
];

export const demoFounders: Founder[] = [
  {
    id: "founder-maya-chen",
    name: "Maya Chen",
    ycProfileUrl: "https://www.ycombinator.com/people/maya-chen",
    linkedinUrl: "https://www.linkedin.com/in/mayachen-demo",
    xUrl: "https://x.com/mayagrid_demo",
    instagramUrl: null,
    personalWebsiteUrl: "https://maya.example",
    review_state: "verified"
  },
  {
    id: "founder-eli-ramos",
    name: "Eli Ramos",
    ycProfileUrl: "https://www.ycombinator.com/people/eli-ramos",
    linkedinUrl: null,
    xUrl: "https://x.com/eliramos_demo",
    instagramUrl: null,
    personalWebsiteUrl: null,
    review_state: "verified"
  },
  {
    id: "founder-sara-okafor",
    name: "Sara Okafor",
    ycProfileUrl: "https://www.ycombinator.com/people/sara-okafor",
    linkedinUrl: "https://www.linkedin.com/in/saraokafor-demo",
    xUrl: null,
    instagramUrl: null,
    personalWebsiteUrl: "https://sara.example",
    review_state: "verified"
  },
  {
    id: "founder-noah-park",
    name: "Noah Park",
    ycProfileUrl: "https://www.ycombinator.com/people/noah-park",
    linkedinUrl: null,
    xUrl: "https://x.com/noahbuilds_demo",
    instagramUrl: null,
    personalWebsiteUrl: null,
    review_state: "verified"
  },
  {
    id: "founder-anjali-mehta",
    name: "Anjali Mehta",
    ycProfileUrl: "https://www.ycombinator.com/people/anjali-mehta",
    linkedinUrl: "https://www.linkedin.com/in/anjalimehta-demo",
    xUrl: "https://x.com/anjali_demo",
    instagramUrl: null,
    personalWebsiteUrl: null,
    review_state: "verified"
  }
];

export const demoCompanyFounders: CompanyFounder[] = [
  {
    companyId: "company-orbitgrid",
    founderId: "founder-maya-chen",
    role: "CEO",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies/orbitgrid"
  },
  {
    companyId: "company-orbitgrid",
    founderId: "founder-eli-ramos",
    role: "CTO",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies/orbitgrid"
  },
  {
    companyId: "company-cliniclens",
    founderId: "founder-sara-okafor",
    role: "Founder",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies/cliniclens"
  },
  {
    companyId: "company-ledgerloop",
    founderId: "founder-noah-park",
    role: "Founder",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies/ledgerloop"
  },
  {
    companyId: "company-synthforge",
    founderId: "founder-anjali-mehta",
    role: "Founder",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies/synthforge"
  }
];

export const demoSocialAccounts: SocialAccount[] = [
  {
    id: "acct-orbitgrid-github",
    entityType: "company",
    entityId: "company-orbitgrid",
    platform: "github",
    handle: "orbitgrid",
    url: "https://github.com/orbitgrid-demo",
    accountId: "orbitgrid-demo",
    followerCount: 1200,
    followingCount: null,
    verified: false,
    review_state: "verified",
    discoveredFromUrl: "https://orbitgrid.example",
    evidence: { reason: "Linked from official website footer" }
  },
  {
    id: "acct-orbitgrid-producthunt",
    entityType: "company",
    entityId: "company-orbitgrid",
    platform: "product_hunt",
    handle: "orbitgrid",
    url: "https://www.producthunt.com/products/orbitgrid",
    accountId: null,
    followerCount: null,
    followingCount: null,
    verified: false,
    review_state: "verified",
    discoveredFromUrl: "https://www.producthunt.com/search?q=OrbitGrid",
    evidence: { reason: "Name and website match demo launch" }
  },
  {
    id: "acct-maya-x",
    entityType: "founder",
    entityId: "founder-maya-chen",
    platform: "x",
    handle: "mayagrid_demo",
    url: "https://x.com/mayagrid_demo",
    accountId: null,
    followerCount: 8400,
    followingCount: 510,
    verified: false,
    review_state: "verified",
    discoveredFromUrl: "https://maya.example",
    evidence: { reason: "Personal website links profile and bio mentions OrbitGrid" }
  },
  {
    id: "acct-cliniclens-web",
    entityType: "company",
    entityId: "company-cliniclens",
    platform: "web",
    handle: null,
    url: "https://cliniclens.example/blog",
    accountId: null,
    followerCount: null,
    followingCount: null,
    verified: false,
    review_state: "verified",
    discoveredFromUrl: "https://cliniclens.example",
    evidence: { reason: "Official blog path discovered on company website" }
  },
  {
    id: "acct-synthforge-youtube",
    entityType: "company",
    entityId: "company-synthforge",
    platform: "youtube",
    handle: "synthforge",
    url: "https://www.youtube.com/@synthforge-demo",
    accountId: null,
    followerCount: 2200,
    followingCount: null,
    verified: false,
    review_state: "verified",
    discoveredFromUrl: "https://synthforge.example",
    evidence: { reason: "Official website link and matching channel name" }
  },
  {
    id: "acct-ledgerloop-github-review",
    entityType: "company",
    entityId: "company-ledgerloop",
    platform: "github",
    handle: "ledger-loop-labs",
    url: "https://github.com/ledger-loop-labs",
    accountId: "ledger-loop-labs",
    followerCount: 330,
    followingCount: null,
    verified: false,
    review_state: "needs_review",
    discoveredFromUrl: "https://github.com/search?q=LedgerLoop",
    evidence: { reason: "Name is similar but official website does not link this profile" }
  },
  {
    id: "acct-allen-instagram-public",
    entityType: "founder",
    entityId: "founder-anjali-mehta",
    platform: "instagram",
    handle: "public.demo.only",
    url: "https://www.instagram.com/public.demo.only",
    accountId: null,
    followerCount: null,
    followingCount: null,
    verified: false,
    review_state: "needs_review",
    discoveredFromUrl: "https://www.google.com/search?q=SynthForge+Instagram",
    evidence: {
      reason: "Public-only Instagram placeholder. No logged-in data collected."
    }
  }
];

export const demoPosts: NormalizedPost[] = [
  {
    id: "post-orbitgrid-launch",
    socialAccountId: "acct-orbitgrid-producthunt",
    platform: "product_hunt",
    platformPostId: "orbitgrid-launch",
    url: "https://www.producthunt.com/posts/orbitgrid",
    authorName: "OrbitGrid",
    authorHandle: "orbitgrid",
    text: "Launch day: coordinate every battery, charger, and solar asset from one control plane.",
    mediaType: "launch",
    postedAt: "2026-06-25T16:00:00.000Z",
    raw: {}
  },
  {
    id: "post-orbitgrid-repo",
    socialAccountId: "acct-orbitgrid-github",
    platform: "github",
    platformPostId: "orbitgrid/scheduler",
    url: "https://github.com/orbitgrid-demo/scheduler",
    authorName: "OrbitGrid",
    authorHandle: "orbitgrid",
    text: "Open-sourced a fleet scheduling simulator for DER operators.",
    mediaType: "repo",
    postedAt: "2026-06-20T12:00:00.000Z",
    raw: {}
  },
  {
    id: "post-maya-x-thread",
    socialAccountId: "acct-maya-x",
    platform: "x",
    platformPostId: "maya-thread-1",
    url: "https://x.com/mayagrid_demo/status/1",
    authorName: "Maya Chen",
    authorHandle: "mayagrid_demo",
    text: "We spent 18 months learning that energy dispatch is an ops product before it is an AI product.",
    mediaType: "text",
    postedAt: "2026-06-26T19:20:00.000Z",
    raw: {}
  },
  {
    id: "post-cliniclens-blog",
    socialAccountId: "acct-cliniclens-web",
    platform: "web",
    platformPostId: "cliniclens-intake-ops",
    url: "https://cliniclens.example/blog/intake-ops",
    authorName: "ClinicLens",
    authorHandle: null,
    text: "How specialty clinics cut intake-to-appointment lag with operational feedback loops.",
    mediaType: "link",
    postedAt: "2026-06-18T14:30:00.000Z",
    raw: {}
  },
  {
    id: "post-synthforge-video",
    socialAccountId: "acct-synthforge-youtube",
    platform: "youtube",
    platformPostId: "synthforge-evals",
    url: "https://www.youtube.com/watch?v=synthforge-demo",
    authorName: "SynthForge",
    authorHandle: "synthforge",
    text: "Demo: shipping a regression suite for AI agents in under ten minutes.",
    mediaType: "video",
    postedAt: "2026-06-22T11:00:00.000Z",
    raw: {}
  },
  {
    id: "post-ledgerloop-review",
    socialAccountId: "acct-ledgerloop-github-review",
    platform: "github",
    platformPostId: "ledger-loop-labs/reconcile",
    url: "https://github.com/ledger-loop-labs/reconcile",
    authorName: "ledger-loop-labs",
    authorHandle: "ledger-loop-labs",
    text: "Potential LedgerLoop repo candidate. Needs review before canonical attachment.",
    mediaType: "repo",
    postedAt: "2026-06-14T11:00:00.000Z",
    raw: {}
  }
];

export const demoMetrics: PostMetrics[] = [
  {
    postId: "post-orbitgrid-launch",
    collectedAt: now,
    upvotes: 612,
    comments: 88,
    raw: {}
  },
  {
    postId: "post-orbitgrid-repo",
    collectedAt: now,
    stars: 980,
    forks: 96,
    watchers: 41,
    issues: 18,
    raw: {}
  },
  {
    postId: "post-maya-x-thread",
    collectedAt: now,
    likes: 1400,
    comments: 118,
    reposts: 310,
    views: 182000,
    raw: {}
  },
  {
    postId: "post-cliniclens-blog",
    collectedAt: now,
    views: 16400,
    shares: 81,
    comments: 25,
    raw: {}
  },
  {
    postId: "post-synthforge-video",
    collectedAt: now,
    views: 45800,
    likes: 1900,
    comments: 142,
    subscribers: 2200,
    raw: {}
  },
  {
    postId: "post-ledgerloop-review",
    collectedAt: now,
    stars: 155,
    forks: 12,
    issues: 4,
    raw: {}
  }
];

export const demoNeedsReview: NeedsReviewItem[] = [
  {
    id: "review-ledgerloop-github",
    entityType: "company",
    entityId: "company-ledgerloop",
    entityName: "LedgerLoop",
    platform: "github",
    candidateUrl: "https://github.com/ledger-loop-labs",
    review_state: "needs_review",
    matchReason:
      "Similar name and fintech repo language, but the official website does not link this GitHub organization."
  },
  {
    id: "review-instagram-public",
    entityType: "founder",
    entityId: "founder-anjali-mehta",
    entityName: "Anjali Mehta",
    platform: "instagram",
    candidateUrl: "https://www.instagram.com/public.demo.only",
    review_state: "needs_review",
    matchReason:
      "Instagram is public-only in this project. Candidate came from search and is not canonical."
  }
];

export function createEvidenceItems(scoresByPost: Map<string, number>): EvidenceItem[] {
  return demoPosts.map((post) => {
    const postId = post.id ?? post.platformPostId;
    const account = demoSocialAccounts.find((item) => item.id === post.socialAccountId);
    const metrics = demoMetrics.find((item) => item.postId === postId);
    const entityType = account?.entityType ?? "company";
    const entityId = account?.entityId ?? "unknown";
    return {
      id: `evidence-${postId}`,
      entityType,
      entityId,
      platform: post.platform,
      author: post.authorName ?? post.authorHandle ?? "Unknown",
      timestamp: post.postedAt,
      text: post.text,
      metrics: metrics ?? { postId, collectedAt: now },
      sourceUrl: post.url,
      contributionScore: scoresByPost.get(postId) ?? 0,
      why: "Stored public/read-only evidence contributed through normalized platform scoring."
    };
  });
}
