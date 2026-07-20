/**
 * Canonical, client-safe post topic taxonomy and deterministic classifier.
 *
 * Keep this module network-free: the same evidence must receive the same topics
 * in ingestion, API, snapshot, and browser contexts.
 */

export const POST_TOPIC_TAXONOMY_VERSION = "post-topics-2026-07-20" as const;
export const POST_TOPIC_CLASSIFIER_VERSION = "post-topics-rules-2026-07-20.1" as const;
export const MAX_AUTOMATIC_POST_TOPICS = 3 as const;

export const POST_TOPIC_TAXONOMY = [
  {
    slug: "traction",
    label: "Traction",
    description: "Measurable adoption, revenue, growth, retention, contracts, or usage progress.",
    aliases: ["growth", "business traction", "customer traction"]
  },
  {
    slug: "product-showcase",
    label: "Product Showcase",
    description: "A demo, screenshot, walkthrough, product tour, or feature demonstration.",
    aliases: ["demo", "product demo", "showcase", "walkthrough"]
  },
  {
    slug: "product-launch",
    label: "Product Launch",
    description: "An announcement that a product or major offering has launched or become available.",
    aliases: ["launch", "launch announcement", "new product"]
  },
  {
    slug: "yc-acceptance",
    label: "YC Acceptance",
    description: "An authored announcement about being accepted into or joining a named YC batch.",
    aliases: ["y combinator acceptance", "yc batch", "accepted to yc", "accepted into yc"]
  },
  {
    slug: "company-vision",
    label: "Company Vision",
    description: "The company's mission, long-term vision, category thesis, or intended future state.",
    aliases: ["vision", "mission", "company mission", "category thesis"]
  },
  {
    slug: "humor",
    label: "Humor",
    description: "An explicit joke, meme, parody, satire, or clearly comedic format.",
    aliases: ["funny", "meme", "comedy", "joke"]
  },
  {
    slug: "customer-win",
    label: "Customer Win",
    description: "A customer selection, testimonial, case study, or successful customer outcome.",
    aliases: ["customer success", "case study", "customer story"]
  },
  {
    slug: "fundraising",
    label: "Fundraising",
    description: "A funding round, investment, or company fundraising announcement.",
    aliases: ["funding", "fundraise", "venture funding", "investment round"]
  },
  {
    slug: "hiring",
    label: "Hiring",
    description: "Open roles, recruiting, or an invitation to join the team.",
    aliases: ["jobs", "careers", "recruiting", "we are hiring"]
  },
  {
    slug: "founder-story",
    label: "Founder Story",
    description: "A founder's origin, personal journey, lessons, or reason for starting the company.",
    aliases: ["founder journey", "origin story", "founding story"]
  },
  {
    slug: "technical-deep-dive",
    label: "Technical Deep Dive",
    description: "A detailed engineering, architecture, implementation, or systems explanation.",
    aliases: ["technical", "deep dive", "engineering deep dive", "architecture"]
  },
  {
    slug: "open-source",
    label: "Open Source",
    description: "Software or technical work released under an open-source model or license.",
    aliases: ["opensource", "oss", "open sourced"]
  },
  {
    slug: "research-or-benchmark",
    label: "Research or Benchmark",
    description: "Original research, a study, paper, evaluation, dataset, or comparative benchmark.",
    aliases: ["research", "benchmark", "study", "paper"]
  },
  {
    slug: "partnership",
    label: "Partnership",
    description: "A formal partnership, collaboration, or strategic integration with another organization.",
    aliases: ["partner", "collaboration", "strategic partnership"]
  },
  {
    slug: "demo-day",
    label: "Demo Day",
    description: "Participation in, preparation for, or an announcement about a Demo Day.",
    aliases: ["demoday", "demo day presentation", "yc demo day"]
  },
  {
    slug: "milestone",
    label: "Milestone",
    description: "A notable company, team, product, or operational achievement.",
    aliases: ["achievement", "anniversary", "company milestone"]
  },
  {
    slug: "product-update",
    label: "Product Update",
    description: "A new feature, release note, changelog entry, improvement, or product change.",
    aliases: ["feature update", "new feature", "changelog", "release notes"]
  },
  {
    slug: "behind-the-scenes",
    label: "Behind the Scenes",
    description: "A look at the team, process, workplace, or making of the product.",
    aliases: ["bts", "making of", "day in the life"]
  },
  {
    slug: "market-insight",
    label: "Market Insight",
    description: "Analysis or a point of view about a market, category, customer behavior, or industry trend.",
    aliases: ["market analysis", "industry insight", "trend analysis"]
  },
  {
    slug: "community",
    label: "Community",
    description: "Community participation, support, gatherings, contributions, or member recognition.",
    aliases: ["community update", "community spotlight", "contributors"]
  },
  {
    slug: "press-or-media",
    label: "Press or Media",
    description: "Press coverage, a media feature, interview, podcast, or publication appearance.",
    aliases: ["press", "media", "press coverage", "in the news"]
  },
  {
    slug: "awards",
    label: "Awards",
    description: "An award, honor, finalist selection, competition win, or formal recognition.",
    aliases: ["award", "recognition", "winner"]
  },
  {
    slug: "event",
    label: "Event",
    description: "An event, conference, meetup, webinar, workshop, or speaking appearance.",
    aliases: ["conference", "meetup", "webinar", "workshop"]
  },
  {
    slug: "culture",
    label: "Culture",
    description: "Company values, team culture, traditions, workplace practices, or an offsite.",
    aliases: ["company culture", "team culture", "values", "offsite"]
  },
  {
    slug: "other",
    label: "Other",
    description: "Content without enough evidence for a more specific canonical topic.",
    aliases: ["uncategorized", "unclassified"]
  }
] as const;

export type PostTopicDefinition = (typeof POST_TOPIC_TAXONOMY)[number];
export type PostTopic = PostTopicDefinition["slug"];
export type PostTopicClassificationMethod = "curated" | "rules" | "fallback";
export type PostTopicRuleStrength = "curated" | "strong" | "moderate" | "fallback";
export type PostTopicMediaType = "text" | "image" | "video" | "link" | "repo" | "launch" | "unknown";

export interface PostTopicClassifierInput {
  /** Valid curated slugs, labels, or aliases replace automatic classification. */
  explicitTopics?: readonly string[] | null;
  title?: string | null;
  text?: string | null;
  rawVisibleText?: string | null;
  hashtags?: readonly string[] | null;
  mediaType?: PostTopicMediaType | null;
}

export interface PostTopicRuleMatch {
  topic: PostTopic;
  score: number;
  confidence: number;
  strength: PostTopicRuleStrength;
  matchedTerms: readonly string[];
}

export interface PostTopicClassification {
  topics: readonly PostTopic[];
  classifierVersion: typeof POST_TOPIC_CLASSIFIER_VERSION;
  taxonomyVersion: typeof POST_TOPIC_TAXONOMY_VERSION;
  method: PostTopicClassificationMethod;
  confidence: number;
  strength: PostTopicRuleStrength;
  matchedTerms: readonly string[];
  matches: readonly PostTopicRuleMatch[];
}

interface WeightedSignal {
  pattern: RegExp;
  weight: number;
}

interface TopicRule {
  topic: Exclude<PostTopic, "other">;
  minimumScore: number;
  strongScore: number;
  signals: readonly WeightedSignal[];
  negativeSignals?: readonly WeightedSignal[];
  mediaWeights?: Readonly<Partial<Record<PostTopicMediaType, number>>>;
}

const TOPIC_RULES: readonly TopicRule[] = [
  {
    topic: "traction",
    minimumScore: 4,
    strongScore: 6,
    signals: [
      { pattern: /(?:\$|usd\s*)[\d,.]+\s*(?:[kmb]\b)?[^.!?\n]{0,18}\b(?:arr|mrr|gmv|revenue)\b/i, weight: 7 },
      { pattern: /\b(?:arr|mrr|gmv|revenue)\b[^.!?\n]{0,18}(?:\$|usd\s*)[\d,.]+\s*(?:[kmb]\b)?/i, weight: 7 },
      { pattern: /\b(?:grew|growing|growth|increased|up)\s+(?:by\s+)?\d+(?:\.\d+)?%/i, weight: 6 },
      { pattern: /\b(?:reached|hit|crossed|surpassed|serving|now at)\s+(?:over\s+|more than\s+)?[\d,.]+\s*(?:[kmb]\b)?\s*(?:users?|customers?|seats?|signups?|subscribers?|waitlist(?: signups?)?|transactions?)\b/i, weight: 6 },
      { pattern: /(?<![\d,.])\d[\d,]*(?:\.\d+)?\s*(?:[kmb]\b)?\s*(?:paid\s+)?(?:users?|customers?|seats?|signups?|subscribers?|waitlist(?: signups?)?|transactions?)\b/i, weight: 5 },
      { pattern: /\b(?:signed|closed|secured|landed|completed)\s+(?:\d+\s+)?(?:new\s+)?(?:pilots?|contracts?|lois?|letters? of intent)\b/i, weight: 5 },
      { pattern: /\b(?:retention|usage|adoption|transaction volume)\b[^.!?\n]{0,24}\b(?:grew|increased|reached|hit|crossed|surpassed|\d+(?:\.\d+)?%)\b/i, weight: 5 },
      { pattern: /\b(?:doubled|tripled)\s+(?:our\s+)?(?:revenue|users?|customers?|usage|adoption|transaction volume)\b/i, weight: 5 },
      { pattern: /\b(?:arr|mrr|gmv|revenue|retention|waitlist|transaction volume|adoption)\b/i, weight: 2 },
      { pattern: /#(?:traction|growth|milestone)\b/i, weight: 2 }
    ]
  },
  {
    topic: "product-showcase",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:product|feature|live|interactive)\s+demo\b/i, weight: 5 },
      { pattern: /\b(?:watch|see|try)\s+(?:the|our|it)\s+(?:demo|in action)\b/i, weight: 5 },
      { pattern: /\b(?:here(?:'s| is) how (?:it|our [\w-]+) works|how it works)\b/i, weight: 5 },
      { pattern: /\b(?:walkthrough|product tour|feature tour|screen recording)\b/i, weight: 5 },
      { pattern: /\b(?:screenshot|demo)\b/i, weight: 3 },
      { pattern: /\b(?:our|the)\s+(?:product|app|platform|feature)\b/i, weight: 2 },
      { pattern: /#(?:productdemo|demo|walkthrough)\b/i, weight: 3 }
    ],
    negativeSignals: [
      { pattern: /\bdemo day\b/i, weight: 5 },
      { pattern: /\b(?:book|schedule|request) a demo\b/i, weight: 3 }
    ],
    mediaWeights: { image: 1, video: 1 }
  },
  {
    topic: "product-launch",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:just\s+)?launched\b/i, weight: 5 },
      { pattern: /\bintroducing\s+(?:our|the|a|an|[A-Z][\w-]+)\b/i, weight: 5 },
      { pattern: /\b(?:now live|available today|shipping (?:now|today)|launching today)\b/i, weight: 5 },
      { pattern: /\b(?:launching|launched|released)\s+(?:our|the|a|an)\s+(?:new\s+)?(?:product|app|platform|service|tool)\b/i, weight: 5 },
      { pattern: /\b(?:launch|launching|launched)\b/i, weight: 2 },
      { pattern: /#(?:launch|productlaunch|shipping)\b/i, weight: 3 }
    ],
    mediaWeights: { launch: 2 }
  },
  {
    topic: "yc-acceptance",
    minimumScore: 6,
    strongScore: 6,
    signals: [
      { pattern: /\b(?:we(?:'ve| have| were)?|i(?:'ve| have| was)?)\s+(?:just\s+)?(?:been\s+)?accepted\s+(?:to|into|by)\s+(?:y combinator|yc)\b/i, weight: 8 },
      { pattern: /\b(?:we(?:'re| are)|i(?:'m| am))\s+(?:excited|thrilled|proud)?\s*(?:to\s+)?(?:join|joining|part of)\s+(?:(?:y combinator|yc)(?:'s)?\s+)?(?:the\s+)?(?:winter|spring|summer|fall|w|s|f)\s*\d{2,4}\s+(?:yc\s+)?batch\b/i, weight: 8 },
      { pattern: /\b(?:joining|accepted into)\s+(?:y combinator|yc)\s+(?:winter|spring|summer|fall|w|s|f)\s*\d{2,4}\b/i, weight: 8 },
      { pattern: /\b(?:we got|i got) into (?:y combinator|yc)\b/i, weight: 8 }
    ],
    negativeSignals: [
      { pattern: /\b(?:apply|applying|application|applications|interview tips?|how to get)\b/i, weight: 8 },
      { pattern: /\bcongratulations? to\b/i, weight: 8 }
    ]
  },
  {
    topic: "company-vision",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:our|the company(?:'s)?)\s+(?:mission|vision)\s+(?:is|:)\b/i, weight: 6 },
      { pattern: /\b(?:long-term vision|category thesis)\b/i, weight: 5 },
      { pattern: /\bwe believe (?:that\s+)?the future\b/i, weight: 5 },
      { pattern: /\b(?:a future|a world) where\b/i, weight: 3 },
      { pattern: /\bwhy we(?:'re| are) building\b/i, weight: 4 },
      { pattern: /\b(?:build|building|create|creating)\b/i, weight: 1 },
      { pattern: /#(?:mission|vision)\b/i, weight: 2 }
    ]
  },
  {
    topic: "humor",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:meme|parody|satire|shitpost|comedy sketch)\b/i, weight: 5 },
      { pattern: /\b(?:here(?:'s| is) a joke|just kidding|plot twist:|expectation vs\.? reality)\b/i, weight: 5 },
      { pattern: /\b(?:knock knock|walks into a bar)\b/i, weight: 5 },
      { pattern: /#(?:meme|memes|parody|satire|startuphumor|techhumor)\b/i, weight: 5 },
      { pattern: /(?:😂|🤣|\blol\b|\bjk\b)/i, weight: 2 }
    ]
  },
  {
    topic: "customer-win",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:customer win|customer success story|customer case study|client case study)\b/i, weight: 6 },
      { pattern: /\b(?:customer|client)\s+(?:chose|selected|picked|switched to)\s+(?:us|our|[\w-]+)\b/i, weight: 5 },
      { pattern: /\bwelcome\s+[\w .&'-]+\s+as (?:a|our) (?:new )?(?:customer|client)\b/i, weight: 5 },
      { pattern: /\b(?:testimonial|case study)\b/i, weight: 4 },
      { pattern: /#(?:customerwin|customersuccess|casestudy)\b/i, weight: 4 }
    ]
  },
  {
    topic: "fundraising",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:raised|closed)\s+(?:a\s+)?(?:\$|usd\s*)[\d,.]+\s*(?:[kmb]\b)?/i, weight: 7 },
      { pattern: /\b(?:raised|raising|closed)\s+(?:our\s+)?(?:pre-seed|seed|series\s+[a-z]|funding|financing)\s+(?:round)?/i, weight: 6 },
      { pattern: /\b(?:pre-seed|seed|series\s+[a-z])\s+(?:funding|financing|round)\b/i, weight: 5 },
      { pattern: /\b(?:fundraise|fundraising|funding round)\b/i, weight: 4 },
      { pattern: /#(?:fundraising|funding|seedround)\b/i, weight: 4 }
    ],
    negativeSignals: [{ pattern: /\b(?:fundraising advice|how to raise|fundraising tips)\b/i, weight: 4 }]
  },
  {
    topic: "hiring",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:we(?:'re| are)|i(?:'m| am)) hiring\b/i, weight: 6 },
      { pattern: /\b(?:join our team|come work with us|open roles?|job openings?|apply for (?:the|our))\b/i, weight: 5 },
      { pattern: /\b(?:hiring|recruiting)\s+(?:an?|for|our next)\b/i, weight: 4 },
      { pattern: /#(?:hiring|jobs|careers|nowhiring)\b/i, weight: 4 }
    ]
  },
  {
    topic: "founder-story",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:why|how) i (?:started|founded|co-founded|built)\b/i, weight: 6 },
      { pattern: /\b(?:my|our) founder (?:story|journey)\b/i, weight: 6 },
      { pattern: /\b(?:founding story|origin story|founder journey)\b/i, weight: 5 },
      { pattern: /\bas a (?:first-time|repeat )?founder\b/i, weight: 4 },
      { pattern: /#(?:founderstory|founderjourney)\b/i, weight: 4 }
    ]
  },
  {
    topic: "technical-deep-dive",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:technical|engineering|architecture) deep dive\b/i, weight: 6 },
      { pattern: /\b(?:under the hood|engineering breakdown|system design|implementation details)\b/i, weight: 5 },
      { pattern: /\bhow we (?:built|scaled|implemented|architected)\b/i, weight: 5 },
      { pattern: /\b(?:architecture|latency|throughput|distributed systems?)\b/i, weight: 2 },
      { pattern: /#(?:engineering|technicaldeepdive|systemdesign)\b/i, weight: 3 }
    ]
  },
  {
    topic: "open-source",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+open[- ]sourced\b/i, weight: 6 },
      { pattern: /\b(?:now|available|released)\s+(?:as\s+)?open source\b/i, weight: 6 },
      { pattern: /\bopen[- ]source\s+(?:release|project|library|framework|license)\b/i, weight: 5 },
      { pattern: /\b(?:apache|mit|gpl)\s+(?:2\.0\s+)?license\b/i, weight: 4 },
      { pattern: /#(?:opensource|oss)\b/i, weight: 4 }
    ]
  },
  {
    topic: "research-or-benchmark",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:our|new)\s+(?:research|study|paper|benchmark|evaluation|dataset)\b/i, weight: 5 },
      { pattern: /\b(?:we (?:studied|evaluated|benchmarked)|benchmark results?|research findings?)\b/i, weight: 5 },
      { pattern: /\b(?:peer-reviewed|arxiv|white paper|technical report)\b/i, weight: 5 },
      { pattern: /\b(?:research|benchmark|study|paper|evaluation)\b/i, weight: 2 },
      { pattern: /#(?:research|benchmark|whitepaper)\b/i, weight: 3 }
    ]
  },
  {
    topic: "partnership",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:we(?:'ve| have| are)?|i(?:'m| am)?)\s+(?:partnered|partnering|collaborated|collaborating)\s+with\b/i, weight: 6 },
      { pattern: /\b(?:announce|announcing|excited about)\s+(?:a|our|this)?\s*(?:strategic )?(?:partnership|collaboration)\b/i, weight: 6 },
      { pattern: /\b(?:strategic partnership|official partner|in partnership with)\b/i, weight: 5 },
      { pattern: /#(?:partnership|collaboration)\b/i, weight: 4 }
    ]
  },
  {
    topic: "demo-day",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:yc\s+)?demo day\b/i, weight: 6 },
      { pattern: /\b(?:presenting|pitching|see you) at demo day\b/i, weight: 6 },
      { pattern: /#(?:demoday|ycdemoday)\b/i, weight: 5 }
    ]
  },
  {
    topic: "milestone",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:major|huge|important|company|team|product) milestone\b/i, weight: 5 },
      { pattern: /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:reached|hit|crossed|celebrated)\s+(?:a|our|the)?\s*(?:new )?milestone\b/i, weight: 6 },
      { pattern: /\b\d+(?:st|nd|rd|th) anniversary\b/i, weight: 5 },
      { pattern: /\bmilestone\b/i, weight: 3 },
      { pattern: /#(?:milestone|anniversary)\b/i, weight: 3 }
    ]
  },
  {
    topic: "product-update",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:product|feature|platform|app) update\b/i, weight: 5 },
      { pattern: /\b(?:new feature|new capability|release notes?|changelog)\b/i, weight: 5 },
      { pattern: /\bwe(?:'ve| have) (?:added|improved|updated|redesigned)\b/i, weight: 4 },
      { pattern: /\b(?:v\d+(?:\.\d+)+|version \d+(?:\.\d+)*)\s+(?:is|now|has)\b/i, weight: 4 },
      { pattern: /#(?:productupdate|newfeature|changelog)\b/i, weight: 4 }
    ]
  },
  {
    topic: "behind-the-scenes",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\bbehind the scenes\b/i, weight: 6 },
      { pattern: /\b(?:day in the life|making of|meet the team|inside our office)\b/i, weight: 5 },
      { pattern: /\bhow (?:we|the team) (?:make|made|work|works)\b/i, weight: 4 },
      { pattern: /#(?:behindthescenes|bts|dayinthelife)\b/i, weight: 4 }
    ]
  },
  {
    topic: "market-insight",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:market|industry|category) (?:analysis|insight|outlook|trend|thesis)\b/i, weight: 5 },
      { pattern: /\b(?:our take|what we(?:'re| are) seeing) (?:on|in) the (?:market|industry|category)\b/i, weight: 5 },
      { pattern: /\bthe (?:market|industry) is (?:shifting|changing|growing|moving)\b/i, weight: 4 },
      { pattern: /#(?:marketinsights|industrytrends)\b/i, weight: 4 }
    ]
  },
  {
    topic: "community",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:our|the) community\s+(?:members?|contributors?|gathered|grew|built|shared)\b/i, weight: 5 },
      { pattern: /\b(?:community spotlight|community update|thank you to our community|contributor spotlight)\b/i, weight: 5 },
      { pattern: /\bjoin (?:our|the) community\b/i, weight: 4 },
      { pattern: /#(?:community|communityspotlight)\b/i, weight: 3 }
    ]
  },
  {
    topic: "press-or-media",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:featured|covered|profiled|quoted) in\s+(?:the\s+)?[\w .&'-]+/i, weight: 5 },
      { pattern: /\b(?:as seen in|in the news|press coverage|media coverage)\b/i, weight: 5 },
      { pattern: /\b(?:listen to|watch|read) (?:our|my|the) (?:podcast|interview|feature)\b/i, weight: 5 },
      { pattern: /#(?:press|inthemedia|podcast)\b/i, weight: 3 }
    ]
  },
  {
    topic: "awards",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:we(?:'ve| have| were)?|i(?:'ve| have| was)?)\s+(?:won|awarded|named|selected|recognized)\b[^.!?\n]{0,30}\b(?:award|winner|finalist|honoree|prize)\b/i, weight: 6 },
      { pattern: /\b(?:award winner|won the .{0,30} award|named a finalist|selected as a finalist)\b/i, weight: 6 },
      { pattern: /\b(?:award|winner|finalist|honoree|prize)\b/i, weight: 2 },
      { pattern: /#(?:award|winner|finalist)\b/i, weight: 3 }
    ]
  },
  {
    topic: "event",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:join us|meet us|see you|speaking|presenting|exhibiting) at\b[^.!?\n]{0,35}\b(?:conference|event|meetup|summit|webinar|workshop)\b/i, weight: 6 },
      { pattern: /\b(?:register|rsvp) (?:now|today|here|for)\b/i, weight: 4 },
      { pattern: /\b(?:live webinar|in-person meetup|annual conference|upcoming event)\b/i, weight: 5 },
      { pattern: /#(?:event|conference|meetup|webinar|workshop)\b/i, weight: 3 }
    ]
  },
  {
    topic: "culture",
    minimumScore: 4,
    strongScore: 5,
    signals: [
      { pattern: /\b(?:our|company|team) culture\b/i, weight: 5 },
      { pattern: /\b(?:our|company) values\b/i, weight: 5 },
      { pattern: /\b(?:team offsite|company offsite|workplace culture|how we work)\b/i, weight: 5 },
      { pattern: /#(?:companyculture|teamculture|offsite)\b/i, weight: 4 }
    ]
  }
] as const;

const VISIBLE_RAW_KEYS = new Set([
  "accessibilitycaption",
  "body",
  "caption",
  "content",
  "description",
  "fulltext",
  "rawtext",
  "text",
  "title",
  "visibletext"
]);
const NON_AUTHORED_RAW_SUBTREES = new Set([
  "author",
  "batchcontext",
  "counts",
  "engagement",
  "metadata",
  "metrics",
  "owner",
  "profile",
  "target",
  "verification"
]);
const MAX_RAW_VISIBLE_TEXT_LENGTH = 50_000;
const MAX_EXTRACTED_RAW_VALUES = 24;
const MAX_RAW_DEPTH = 8;

export const POST_TOPIC_SLUGS: readonly PostTopic[] = POST_TOPIC_TAXONOMY.map((topic) => topic.slug);

export function isPostTopic(value: string): value is PostTopic {
  return POST_TOPIC_TAXONOMY.some((topic) => topic.slug === value);
}

/** Resolve a canonical slug from a slug, display label, or declared alias. */
export function normalizePostTopic(value: string): PostTopic | null {
  const normalized = normalizeAlias(value);
  if (!normalized) {
    return null;
  }

  const definition = POST_TOPIC_TAXONOMY.find((topic) =>
    [topic.slug, topic.label, ...topic.aliases].some((candidate) => normalizeAlias(candidate) === normalized)
  );
  return definition?.slug ?? null;
}

export function getPostTopicDefinition(topic: PostTopic): PostTopicDefinition {
  const definition = POST_TOPIC_TAXONOMY.find((candidate) => candidate.slug === topic);
  if (!definition) {
    throw new Error(`Unknown canonical post topic: ${topic}`);
  }
  return definition;
}

/** Deduplicate and restore canonical taxonomy order. Invalid values are ignored. */
export function normalizePostTopics(values: readonly string[]): PostTopic[] {
  const selected = new Set<PostTopic>();
  for (const value of values) {
    const topic = normalizePostTopic(value);
    if (topic) {
      selected.add(topic);
    }
  }
  return POST_TOPIC_SLUGS.filter((topic) => selected.has(topic));
}

export function classifyPostTopics(input: PostTopicClassifierInput): PostTopicClassification {
  const curatedTopics = normalizePostTopics(input.explicitTopics ?? []);
  if (curatedTopics.length > 0) {
    const matches = curatedTopics.map((topic): PostTopicRuleMatch => ({
      topic,
      score: 1,
      confidence: 1,
      strength: "curated",
      matchedTerms: [getPostTopicDefinition(topic).label]
    }));
    return classificationResult(curatedTopics, "curated", 1, "curated", matches);
  }

  const authoredText = buildAuthoredText(input);
  const automaticMatches = TOPIC_RULES.map((rule, taxonomyIndex) => ({
    match: evaluateRule(rule, authoredText, input.mediaType ?? "unknown"),
    taxonomyIndex
  }))
    .filter((candidate): candidate is { match: PostTopicRuleMatch; taxonomyIndex: number } => candidate.match !== null)
    .sort((left, right) => right.match.score - left.match.score || left.taxonomyIndex - right.taxonomyIndex)
    .slice(0, MAX_AUTOMATIC_POST_TOPICS)
    .map((candidate) => candidate.match);

  if (automaticMatches.length === 0) {
    const fallback: PostTopicRuleMatch = {
      topic: "other",
      score: 0,
      confidence: 0.25,
      strength: "fallback",
      matchedTerms: []
    };
    return classificationResult(["other"], "fallback", fallback.confidence, "fallback", [fallback]);
  }

  const strongest = automaticMatches[0];
  return classificationResult(
    automaticMatches.map((match) => match.topic),
    "rules",
    strongest.confidence,
    strongest.strength,
    automaticMatches
  );
}

/**
 * Extract only authored/visible text fields from raw JSON. Metadata fields such
 * as counts, verification, target, and batch context are intentionally ignored.
 */
export function extractPostVisibleText(rawVisibleText: string | null | undefined): string {
  const raw = rawVisibleText?.trim();
  if (!raw) {
    return "";
  }

  const bounded = raw.slice(0, MAX_RAW_VISIBLE_TEXT_LENGTH);
  if (!bounded.startsWith("{") && !bounded.startsWith("[")) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded);
  } catch {
    return "";
  }

  const values: string[] = [];
  collectVisibleValues(parsed, "", 0, values);
  return normalizeText(values.join(" "));
}

function classificationResult(
  topics: readonly PostTopic[],
  method: PostTopicClassificationMethod,
  confidence: number,
  strength: PostTopicRuleStrength,
  matches: readonly PostTopicRuleMatch[]
): PostTopicClassification {
  return {
    topics,
    classifierVersion: POST_TOPIC_CLASSIFIER_VERSION,
    taxonomyVersion: POST_TOPIC_TAXONOMY_VERSION,
    method,
    confidence,
    strength,
    matchedTerms: uniqueStrings(matches.flatMap((match) => match.matchedTerms)),
    matches
  };
}

function evaluateRule(
  rule: TopicRule,
  text: string,
  mediaType: PostTopicMediaType
): PostTopicRuleMatch | null {
  let score = 0;
  const matchedTerms: string[] = [];

  for (const signal of rule.signals) {
    const match = signal.pattern.exec(text);
    if (match?.[0]) {
      score += signal.weight;
      matchedTerms.push(normalizeText(match[0]));
    }
  }

  if (score > 0) {
    const mediaWeight = rule.mediaWeights?.[mediaType] ?? 0;
    if (mediaWeight > 0) {
      score += mediaWeight;
      matchedTerms.push(`media:${mediaType}`);
    }
  }

  for (const signal of rule.negativeSignals ?? []) {
    if (signal.pattern.test(text)) {
      score -= signal.weight;
    }
  }

  if (score < rule.minimumScore) {
    return null;
  }

  const strength: PostTopicRuleStrength = score >= rule.strongScore ? "strong" : "moderate";
  return {
    topic: rule.topic,
    score,
    confidence: ruleConfidence(score, rule.minimumScore, rule.strongScore),
    strength,
    matchedTerms: uniqueStrings(matchedTerms)
  };
}

function buildAuthoredText(input: PostTopicClassifierInput): string {
  const hashtags = (input.hashtags ?? [])
    .map((hashtag) => hashtag.trim())
    .filter(Boolean)
    .map((hashtag) => (hashtag.startsWith("#") ? hashtag : `#${hashtag}`));
  return normalizeText([
    input.title ?? "",
    input.text ?? "",
    extractPostVisibleText(input.rawVisibleText),
    ...hashtags
  ].join(" "));
}

function collectVisibleValues(value: unknown, parentKey: string, depth: number, values: string[]): void {
  if (depth > MAX_RAW_DEPTH || values.length >= MAX_EXTRACTED_RAW_VALUES) {
    return;
  }
  if (typeof value === "string") {
    if (VISIBLE_RAW_KEYS.has(normalizeRawKey(parentKey))) {
      values.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVisibleValues(item, parentKey, depth + 1, values);
      if (values.length >= MAX_EXTRACTED_RAW_VALUES) {
        break;
      }
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    if (NON_AUTHORED_RAW_SUBTREES.has(normalizeRawKey(key))) {
      continue;
    }
    const child: unknown = Reflect.get(value, key);
    collectVisibleValues(child, key, depth + 1, values);
    if (values.length >= MAX_EXTRACTED_RAW_VALUES) {
      break;
    }
  }
}

function normalizeRawKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeAlias(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }
  }
  return unique;
}

function ruleConfidence(score: number, minimumScore: number, strongScore: number): number {
  if (score >= strongScore) {
    return Math.min(0.99, roundConfidence(0.85 + (score - strongScore) * 0.025));
  }
  const span = Math.max(1, strongScore - minimumScore);
  return roundConfidence(0.6 + ((score - minimumScore) / span) * 0.2);
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}
