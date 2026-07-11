#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const OUTPUT_PATH = resolve("src/lib/social/a16z-speedrun-006-social-accounts.json");
const SNAPSHOT_GENERATED_AT = "2026-07-11T00:00:00.000Z";
const BATCH_SLUG = "A16ZSR006";
const BATCH_LABEL = "a16z Speedrun 006";
const SOURCE_PATH = "scripts/ingest-a16z-speedrun-social-accounts.mjs";
const PLATFORM_ORDER = [
  "github",
  "linkedin",
  "x",
  "instagram",
  "youtube",
  "reddit",
  "product_hunt",
  "hacker_news",
  "bilibili"
];
const RESERVED_GITHUB_PATHS = new Set([
  "about",
  "apps",
  "blog",
  "collections",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "login",
  "marketplace",
  "new",
  "orgs",
  "organizations",
  "pricing",
  "search",
  "security",
  "settings",
  "signup",
  "sponsors",
  "topics"
]);
const RESERVED_X_PATHS = new Set([
  "compose",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "messages",
  "notifications",
  "search",
  "share"
]);
const RESERVED_INSTAGRAM_PATHS = new Set([
  "about",
  "accounts",
  "developer",
  "direct",
  "explore",
  "p",
  "reel",
  "reels",
  "stories"
]);
const RESERVED_REDDIT_PATHS = new Set(["account", "advertising", "coins", "login", "message", "notifications", "poll", "search", "settings", "submit"]);
const FOUNDER_SLUG_OVERRIDES = new Map([
  ["Oasis/Stefano Fantini Delmanto", "stefano-delmanto"],
  ["Prior Foundry/Johne Kamphorst", "jonne-kamphorst"],
  ["SUN/Matt Gunhan Ertosun", "matt-gunhan-ertosun-phd"]
]);

const SPEEDRUN_COMPANIES = [
  { name: "Acceler8", founders: ["Chinmay Chauhan", "Trisha Pathak"] },
  { name: "Advocate", founders: ["Andrew Baran"] },
  { name: "Alike", founders: ["Addi Haran Diman", "Max Van Kleek", "Danial Hussain"] },
  { name: "Amdahl", founders: ["Annette Sung", "Robert Khoury", "Arya Soltanieh"] },
  { name: "Antihero Studios", founders: ["Brice Laville Saint Martin", "Andre Parodi", "Frank Yu Yan"] },
  { name: "August", founders: ["Bar Ittah", "Tom Tankilevitch"] },
  { name: "Auto", founders: ["Dave Evans", "Sam Hare"] },
  { name: "Belong", founders: ["Nick Holmsten", "Ash Pournouri"] },
  { name: "Bilrost", founders: ["Silvia Chen", "Peter Hsu"] },
  { name: "Bota", founders: ["Ruming Zhen", "Qi Zhang"] },
  { name: "Cascade", founders: ["Hannia Zia", "Joana Ferreira"] },
  { name: "Cedar", founders: ["Greg Gunn", "Beier Cai"] },
  { name: "Clair Health", founders: ["Jenny Duan"] },
  { name: "Coalition Systems", founders: ["Vijay Pathak", "Freddie Wollen"] },
  { name: "Concorda", founders: ["Samuel Oh", "Ke Ma"] },
  { name: "Crebit", founders: ["Jensen Coonradt", "Simmi Sen"] },
  { name: "Emanate", founders: ["Kiara Nirghin"] },
  { name: "Grove Tax", founders: ["Uday Nandam", "Gaurav Mathur"] },
  { name: "Hammock", founders: ["Jesse Rose", "Will Dennis"] },
  { name: "Heavi", founders: ["Sanjay Dasari", "Michael Holkesvik"] },
  { name: "Hotbox", founders: ["Harpriya Bagri"] },
  { name: "Idilio", founders: ["Gabriela Tafur", "Esteban Ramirez"] },
  { name: "Kaaro", founders: ["Sai Surisetti", "Gautham Venkateshwaran"] },
  { name: "Loops AI", founders: ["Ari Nazir", "Ilker Zorluoglu", "Yusuf Bahadir", "Hakan Bas"] },
  { name: "Meridian", founders: ["Kashyap Nathan", "Chris Farrington"] },
  { name: "Miraka", founders: ["Nolan Abeyta", "Kazuo Nakamura", "Jesse Abeyta"] },
  { name: "Mirror Mirror AI", founders: ["Yusan Lin"] },
  { name: "Modaic", founders: ["Farouk Adeleke", "Tyrin-Ian Todd"] },
  { name: "Modern Industrials", founders: ["Austin Mao", "Vatsal Bhargava", "Ankit Bhargava"] },
  { name: "Oasis", founders: ["Stefano Fantini Delmanto", "Naveen Sharma"] },
  { name: "Oasiz", founders: ["Abel Dagne", "Jonathan Dinh"] },
  { name: "Omi Health", founders: ["Sindu Chaparala", "Jakob Spiess"] },
  { name: "Panorama", founders: ["Jingwei Hao", "Jaclyn Lunger"] },
  { name: "PartyHat", founders: ["Jarret Cuisinier", "Vijay Myneni"] },
  { name: "PayPath", founders: ["Dean Glas", "Matthew Lippl", "Matthew Angelini"] },
  { name: "PicPet", founders: ["Jimmy Huang"] },
  { name: "Piper-ai", founders: ["Ido Gedanken", "Erez Tepper", "Roi Menzin"] },
  { name: "Pluvo", founders: ["Alexandre Labreche", "Andrew Ingram", "Seb Fallenbuchl", "Vanessa Galarneau"] },
  { name: "Prior Foundry", founders: ["Shirin Abrishami Kashani", "Keshav Sivakumar", "Johne Kamphorst"] },
  { name: "Quanto", founders: ["Anderson Petergeorge", "Kajanth Nithiyananthan"] },
  { name: "Quinn", founders: ["Ben Anderson", "Arlen Marmel"] },
  { name: "Quo Labs", founders: ["Audrey Lo", "Jenny Wen"] },
  { name: "SafeWorld", founders: ["Kyle Wong", "Simo Rachidi", "Ding Zhao"] },
  { name: "Sellara", founders: ["Charles-Andre Jolly", "Ahmad Roumie", "Spencer Secord"] },
  { name: "Sentra", founders: ["Ashwin Gopinath", "Andrey Starenky"] },
  { name: "Simula", founders: ["Yizhen Zhen"] },
  { name: "Sirius Technology", founders: ["Azamat K", "Benazir Toleubekova"] },
  { name: "Smart Bricks", founders: ["Mohamed Mohamed"] },
  { name: "snag", founders: ["Selin Sonmez", "Niko Georgantas"] },
  { name: "Snapp Stats", founders: ["Shawn Tsao", "Andrew Tamura", "Min Park", "Alex Marshall"] },
  { name: "Sparta", founders: ["Arya Kanna", "Saad Asad", "Lalith Posam"] },
  { name: "Straia", founders: ["Ryan Lau", "Alan Chan", "Gautam Narasimhan", "Nikki Dansey"] },
  { name: "SUN", founders: ["Artin Bogdanov", "Matt Gunhan Ertosun"] },
  { name: "Syncere", founders: ["Aaron Tan", "Angus Fung"] },
  { name: "Taxnova", founders: ["George Nichkov", "Maria Malykh"] },
  { name: "Thirdbrain Labs", founders: ["Margaret Zhang", "David Huang"] },
  { name: "VariantNow", founders: ["Elad Nissenberg", "Ben Segal"] },
  { name: "Vereda", founders: ["Joao Souza", "Pedro Galindo"] },
  { name: "ZeroDrift", founders: ["Kumesh Aroomoogan"] }
];

const SOCIAL_ACCOUNTS = [
  { companyName: "Acceler8", url: "https://www.linkedin.com/company/theacceler8" },
  { companyName: "Amdahl", url: "https://github.com/amdahl-ai" },
  { companyName: "Amdahl", url: "https://github.com/amdahlco" },
  { companyName: "Amdahl", url: "https://www.linkedin.com/company/amdahl-ai" },
  { companyName: "Amdahl", url: "https://x.com/amdahl_ai" },
  { companyName: "Antihero Studios", url: "https://www.linkedin.com/company/antihero-studios" },
  { companyName: "Antihero Studios", url: "https://www.linkedin.com/company/antiherostudios-games" },
  { companyName: "Antihero Studios", url: "https://x.com/antihero_games" },
  { companyName: "Antihero Studios", url: "https://www.instagram.com/antihero.studios" },
  { companyName: "Antihero Studios", url: "https://www.youtube.com/@Antihero_Studios" },
  { companyName: "Auto", url: "https://www.linkedin.com/company/automatic-platforms" },
  { companyName: "Auto", url: "https://x.com/autoaicam" },
  { companyName: "Belong", url: "https://github.com/Belong-dev" },
  { companyName: "Belong", url: "https://www.linkedin.com/company/belongrewards" },
  { companyName: "Belong", url: "https://x.com/belongrewards" },
  { companyName: "Belong", url: "https://www.instagram.com/belongrewards" },
  { companyName: "Bilrost", url: "https://www.linkedin.com/company/bilrost-ai" },
  { companyName: "Bota", url: "https://www.linkedin.com/company/botadev" },
  { companyName: "Cascade", url: "https://www.linkedin.com/company/use-cascade" },
  { companyName: "Cascade", founderName: "Hannia Zia", url: "https://www.linkedin.com/in/hanniazia" },
  { companyName: "Cascade", founderName: "Joana Ferreira", url: "https://www.linkedin.com/in/joanaferreira0011" },
  { companyName: "Cedar", url: "https://www.linkedin.com/company/cedar-ai" },
  { companyName: "Clair Health", url: "https://www.instagram.com/clair_health" },
  { companyName: "Clair Health", url: "https://www.linkedin.com/company/clairhealth" },
  { companyName: "Clair Health", founderName: "Jenny Duan", url: "https://www.linkedin.com/in/jennysduan" },
  { companyName: "Coalition Systems", url: "https://www.linkedin.com/company/coalition-systems" },
  { companyName: "Coalition Systems", founderName: "Vijay Pathak", url: "https://www.linkedin.com/in/vijayppathak" },
  { companyName: "Coalition Systems", founderName: "Freddie Wollen", url: "https://www.linkedin.com/in/frederick-wollen" },
  { companyName: "Concorda", url: "https://www.linkedin.com/company/concordahq" },
  { companyName: "Crebit", url: "https://www.linkedin.com/company/crebit-pay" },
  { companyName: "Crebit", founderName: "Jensen Coonradt", url: "https://www.linkedin.com/in/jcoonradt" },
  { companyName: "Crebit", founderName: "Jensen Coonradt", url: "https://www.youtube.com/@roborebel6031" },
  { companyName: "Emanate", url: "https://www.linkedin.com/company/emanateai" },
  { companyName: "Emanate", url: "https://x.com/emanateai" },
  { companyName: "Grove Tax", url: "https://github.com/grove-tax" },
  { companyName: "Grove Tax", url: "https://www.linkedin.com/company/grovetax-ai" },
  { companyName: "Hammock", url: "https://www.instagram.com/usehammock.co" },
  { companyName: "Hammock", url: "https://www.linkedin.com/company/usehammockco" },
  { companyName: "Heavi", url: "https://www.linkedin.com/company/heavi-ai" },
  { companyName: "Hotbox", url: "https://www.linkedin.com/company/hotboxapp" },
  { companyName: "Hotbox", founderName: "Harpriya Bagri", url: "https://www.linkedin.com/in/harpriya" },
  { companyName: "Hotbox", founderName: "Harpriya Bagri", url: "https://x.com/harpriiya" },
  { companyName: "Idilio", url: "https://www.instagram.com/idiliotv" },
  { companyName: "Idilio", url: "https://www.linkedin.com/company/idiliotv" },
  { companyName: "Idilio", founderName: "Gabriela Tafur", url: "https://www.instagram.com/gabrielatafur" },
  { companyName: "Kaaro", url: "https://www.linkedin.com/company/kaaro-ai" },
  { companyName: "Kaaro", url: "https://x.com/kaaroai" },
  { companyName: "Loops AI", url: "https://www.instagram.com/loopsai_co" },
  { companyName: "Loops AI", url: "https://www.linkedin.com/company/loopsai" },
  { companyName: "Meridian", url: "https://www.linkedin.com/company/try-meridian" },
  { companyName: "Meridian", url: "https://x.com/tryMerid1an" },
  { companyName: "Miraka", url: "https://www.linkedin.com/company/mirakaai" },
  { companyName: "Mirror Mirror AI", url: "https://www.instagram.com/mirrormirror.ai" },
  { companyName: "Mirror Mirror AI", url: "https://www.linkedin.com/company/mirror-mirror-ai" },
  { companyName: "Mirror Mirror AI", url: "https://x.com/mirrormirror_ai" },
  { companyName: "Mirror Mirror AI", url: "https://www.youtube.com/@MirrorMirrorAI" },
  { companyName: "Mirror Mirror AI", founderName: "Yusan Lin", url: "https://www.instagram.com/yusan.lin" },
  { companyName: "Modaic", url: "https://github.com/modaic-ai" },
  { companyName: "Modaic", url: "https://www.linkedin.com/company/modaicdev" },
  { companyName: "Modaic", url: "https://x.com/modaicdev" },
  { companyName: "Modern Industrials", url: "https://www.linkedin.com/company/modern-industrials" },
  { companyName: "Oasis", url: "https://www.linkedin.com/company/Oasis-HQ" },
  { companyName: "Oasis", url: "https://x.com/OasisHQ" },
  { companyName: "Oasiz", url: "https://www.linkedin.com/company/oasiz" },
  { companyName: "Oasiz", url: "https://x.com/playoasiz" },
  { companyName: "Omi Health", url: "https://www.linkedin.com/company/108841079" },
  { companyName: "Omi Health", url: "https://x.com/omipethealth" },
  { companyName: "Omi Health", url: "https://www.instagram.com/omipethealth" },
  { companyName: "Omi Health", url: "https://www.youtube.com/@omi-health" },
  { companyName: "Panorama", url: "https://github.com/panorama-dev" },
  { companyName: "Panorama", url: "https://www.linkedin.com/company/withpanorama" },
  { companyName: "Panorama", url: "https://x.com/withpanorama" },
  { companyName: "PartyHat", url: "https://x.com/getpartyhat" },
  { companyName: "PartyHat", url: "https://www.instagram.com/officialpartyhat" },
  { companyName: "PayPath", url: "https://www.linkedin.com/company/paypath" },
  { companyName: "PicPet", url: "https://www.instagram.com/picpet.app" },
  { companyName: "Pluvo", url: "https://www.linkedin.com/company/pluvoapp" },
  { companyName: "Pluvo", url: "https://x.com/Pluvoapp" },
  { companyName: "Pluvo", url: "https://www.instagram.com/pluvoapp" },
  { companyName: "Piper-ai", url: "https://www.linkedin.com/company/piper-ai-team" },
  { companyName: "Prior Foundry", url: "https://www.linkedin.com/company/prior-foundry" },
  { companyName: "Quanto", url: "https://www.linkedin.com/company/quantohq" },
  { companyName: "Quanto", url: "https://www.producthunt.com/products/quanto" },
  { companyName: "Quinn", url: "https://www.linkedin.com/company/meetquinn" },
  { companyName: "Quinn", url: "https://www.linkedin.com/company/meetquinnai" },
  { companyName: "Quinn", url: "https://x.com/meetquinn" },
  { companyName: "Quo Labs", url: "https://www.linkedin.com/company/quo-labs" },
  { companyName: "Quo Labs", url: "https://x.com/quolabsai" },
  { companyName: "SafeWorld", founderName: "Kyle Wong", url: "https://www.linkedin.com/in/kylewong" },
  { companyName: "SafeWorld", founderName: "Kyle Wong", url: "https://x.com/kwong47" },
  { companyName: "Sellara", url: "https://www.linkedin.com/company/sellara" },
  { companyName: "Sellara", url: "https://x.com/SellaraHQ" },
  { companyName: "Sentra", url: "https://www.linkedin.com/company/sentra-app" },
  { companyName: "Sentra", url: "https://x.com/sentra_app" },
  { companyName: "Sirius Technology", url: "https://www.linkedin.com/company/thesiriusai" },
  { companyName: "Sirius Technology", url: "https://x.com/siriusai" },
  { companyName: "Simula", url: "https://www.linkedin.com/company/simula-ad" },
  { companyName: "Simula", url: "https://x.com/simula_ad" },
  { companyName: "Smart Bricks", url: "https://www.linkedin.com/company/smart-bricks" },
  { companyName: "Smart Bricks", url: "https://www.instagram.com/smartbricks_invest" },
  { companyName: "Smart Bricks", url: "https://www.instagram.com/smartbricks.invest" },
  { companyName: "Smart Bricks", url: "https://x.com/Smart_Bricks_" },
  { companyName: "Smart Bricks", url: "https://www.youtube.com/@investwithsmartbricks" },
  { companyName: "snag", url: "https://www.instagram.com/snagsubletsnyc" },
  { companyName: "snag", url: "https://www.youtube.com/@snagsublets" },
  { companyName: "snag", founderName: "Selin Sonmez", url: "https://www.instagram.com/subletgirl" },
  { companyName: "Snapp Stats", url: "https://www.linkedin.com/company/snappstats" },
  { companyName: "Snapp Stats", url: "https://www.instagram.com/snappstats" },
  { companyName: "Snapp Stats", url: "https://x.com/SnappStats" },
  { companyName: "Sparta", url: "https://www.linkedin.com/company/usesparta" },
  { companyName: "Straia", url: "https://www.linkedin.com/company/straia-ai" },
  { companyName: "Straia", founderName: "Gautam Narasimhan", url: "https://www.linkedin.com/in/gautamna" },
  { companyName: "SUN", url: "https://www.linkedin.com/company/sunisrising" },
  { companyName: "SUN", url: "https://www.youtube.com/@getsunapp" },
  { companyName: "SUN", url: "https://www.producthunt.com/products/sun-ai" },
  { companyName: "SUN", founderName: "Artin Bogdanov", url: "https://www.instagram.com/artinbogdanov" },
  { companyName: "Syncere", url: "https://www.linkedin.com/company/bysyncere" },
  { companyName: "Syncere", url: "https://www.instagram.com/bysyncere" },
  { companyName: "Syncere", url: "https://x.com/bysyncere" },
  { companyName: "Taxnova", url: "https://github.com/TaxNova-AI" },
  { companyName: "Taxnova", url: "https://www.linkedin.com/company/taxnova-ai" },
  { companyName: "Taxnova", url: "https://www.producthunt.com/products/taxnova" },
  { companyName: "Taxnova", url: "https://x.com/taxnovaai" },
  { companyName: "Thirdbrain Labs", url: "https://www.linkedin.com/company/thirdbrain-labs" },
  { companyName: "Thirdbrain Labs", url: "https://x.com/ThirdbrainLabs" },
  { companyName: "VariantNow", url: "https://www.linkedin.com/company/variantnow" },
  { companyName: "VariantNow", url: "https://x.com/variantnow" },
  { companyName: "Vereda", url: "https://www.linkedin.com/company/vereda-ia" },
  { companyName: "Vereda", url: "https://www.instagram.com/vereda.ia" },
  { companyName: "ZeroDrift", url: "https://www.linkedin.com/company/zerodrift" },
  { companyName: "ZeroDrift", url: "https://x.com/ZeroDrift_AI" },
  { companyName: "ZeroDrift", url: "https://www.youtube.com/@ZeroDrift-AI" }
].map((account) => ({
  verifiedFrom: "agent_verified_native_account",
  evidenceUrl: account.url,
  matchReason: "Native social account found during A16Z Speedrun 006 profile audit.",
  ...account
}));

const snapshot = await buildSnapshot();
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
const accountSummary = summarizeAccounts(snapshot.companies);
console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`Companies with native social accounts: ${accountSummary.companyCountWithAccounts}`);
console.log(`Social account counts by platform: ${JSON.stringify(accountSummary.countsByPlatform)}`);
console.log(`Remaining companies without native accounts: ${accountSummary.companiesWithoutAccounts.join(", ")}`);

async function buildSnapshot() {
  validateCompanyRoster();

  const companies = SPEEDRUN_COMPANIES.map((company) => ({
    companyName: company.name,
    companySlug: slugify(company.name),
    accounts: [],
    founders: company.founders.map((name) => ({
      name,
      founderSlug: slugify(name),
      accounts: []
    }))
  }));
  const companiesByName = new Map(companies.map((company) => [company.companyName, company]));

  for (const sourceAccount of SOCIAL_ACCOUNTS) {
    const company = companiesByName.get(sourceAccount.companyName);
    if (!company) throw new Error(`Unknown company in SOCIAL_ACCOUNTS: ${sourceAccount.companyName}`);

    const account = {
      ...classifySocialAccountUrl(sourceAccount.url),
      verifiedFrom: sourceAccount.verifiedFrom,
      evidenceUrl: sourceAccount.evidenceUrl,
      matchReason: sourceAccount.matchReason ?? "Native social account found during A16Z Speedrun 006 profile audit.",
      review_state: "verified"
    };
    if (sourceAccount.founderName) {
      const founder = company.founders.find((item) => item.name === sourceAccount.founderName);
      if (!founder) {
        throw new Error(`Unknown founder in SOCIAL_ACCOUNTS: ${sourceAccount.companyName} / ${sourceAccount.founderName}`);
      }
      founder.accounts = dedupeAndSortAccounts([...founder.accounts, account]);
    } else {
      company.accounts = dedupeAndSortAccounts([...company.accounts, account]);
    }
  }

  for (const sourceAccount of await fetchFounderSocialAccountsFromSpeedrun(companies)) {
    const company = companiesByName.get(sourceAccount.companyName);
    if (!company) throw new Error(`Unknown company in fetched founder account: ${sourceAccount.companyName}`);
    const founder = company.founders.find((item) => item.name === sourceAccount.founderName);
    if (!founder) {
      throw new Error(`Unknown founder in fetched founder account: ${sourceAccount.companyName} / ${sourceAccount.founderName}`);
    }

    const account = {
      ...classifySocialAccountUrl(sourceAccount.url),
      verifiedFrom: sourceAccount.verifiedFrom,
      evidenceUrl: sourceAccount.evidenceUrl,
      matchReason: sourceAccount.matchReason,
      review_state: "verified"
    };
    founder.accounts = dedupeAndSortAccounts([...founder.accounts, account]);
  }

  const founderAccountCount = companies.reduce(
    (total, company) => total + company.founders.reduce((founderTotal, founder) => founderTotal + founder.accounts.length, 0),
    0
  );
  const companyAccountCount = companies.reduce((total, company) => total + company.accounts.length, 0);
  const usedPlatforms = [...new Set(companies.flatMap((company) => [
    ...company.accounts.map((account) => account.platform),
    ...company.founders.flatMap((founder) => founder.accounts.map((account) => account.platform))
  ]))].sort(comparePlatforms);

  return {
    source: {
      label: "Verified social account seed snapshot for a16z Speedrun 006",
      batchSlug: BATCH_SLUG,
      batchLabel: BATCH_LABEL,
      sourcePath: SOURCE_PATH,
      generatedAt: SNAPSHOT_GENERATED_AT,
      companyCount: companies.length,
      companyAccountCount,
      founderAccountCount,
      accountCount: companyAccountCount + founderAccountCount,
      supportedPlatforms: PLATFORM_ORDER,
      platformsPresent: usedPlatforms,
      verificationSources: verificationSourcesFor(companies),
      notes: [
        "Company accounts are generated from the hard-coded SOCIAL_ACCOUNTS list in the source script.",
        "Founder accounts are generated from native social URLs exposed on each founder's A16Z Speedrun profile page.",
        "No login, private crawling, or mutation is performed.",
        "Companies and founders with no verified account remain present with empty account arrays."
      ]
    },
    companies
  };
}

async function fetchFounderSocialAccountsFromSpeedrun(companies) {
  const accountGroups = await mapWithConcurrency(
    companies.flatMap((company) =>
      company.founders.map((founder) => ({ company, founder }))
    ),
    8,
    async ({ company, founder }) => {
      const profileUrl = speedrunFounderUrl(company, founder);
      const response = await fetch(profileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${profileUrl}: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const dataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!dataMatch) {
        throw new Error(`Missing __NEXT_DATA__ on ${profileUrl}`);
      }

      const pageFounder = JSON.parse(dataMatch[1]).props?.pageProps?.founder;
      if (!pageFounder) {
        throw new Error(`Missing founder payload on ${profileUrl}`);
      }

      return founderSocialUrls(pageFounder).map((url) => ({
        companyName: company.companyName,
        founderName: founder.name,
        url,
        verifiedFrom: "speedrun_founder_profile_page",
        evidenceUrl: profileUrl,
        matchReason: "Native social account exposed on the founder's A16Z Speedrun profile."
      }));
    }
  );

  return accountGroups.flat();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(...await Promise.all(items.slice(index, index + concurrency).map(mapper)));
  }
  return results;
}

function speedrunFounderUrl(company, founder) {
  const founderSlug = FOUNDER_SLUG_OVERRIDES.get(`${company.companyName}/${founder.name}`) ?? founder.founderSlug;
  return `https://speedrun.a16z.com/companies/${company.companySlug}/${founderSlug}`;
}

function founderSocialUrls(founder) {
  return [
    founder.github_url,
    founder.linkedin_url,
    founder.x_url,
    founder.instagram_url,
    founder.youtube_url,
    founder.reddit_url
  ].filter(isSupportedSocialAccountUrl);
}

function isSupportedSocialAccountUrl(url) {
  if (!url) return false;
  try {
    classifySocialAccountUrl(url);
    return true;
  } catch {
    return false;
  }
}

function verificationSourcesFor(companies) {
  return [...new Set(companies.flatMap((company) => [
    ...company.accounts.map((account) => account.verifiedFrom),
    ...company.founders.flatMap((founder) => founder.accounts.map((account) => account.verifiedFrom))
  ]))].sort();
}

function summarizeAccounts(companies) {
  const countsByPlatform = Object.fromEntries(PLATFORM_ORDER.map((platform) => [platform, 0]));
  const companiesWithoutAccounts = [];
  let companyCountWithAccounts = 0;

  for (const company of companies) {
    let accountCount = 0;

    for (const account of company.accounts ?? []) {
      countsByPlatform[account.platform] = (countsByPlatform[account.platform] ?? 0) + 1;
      accountCount += 1;
    }

    for (const founder of company.founders ?? []) {
      for (const account of founder.accounts ?? []) {
        countsByPlatform[account.platform] = (countsByPlatform[account.platform] ?? 0) + 1;
        accountCount += 1;
      }
    }

    if (accountCount > 0) {
      companyCountWithAccounts += 1;
    } else {
      companiesWithoutAccounts.push(company.companyName);
    }
  }

  return { countsByPlatform, companyCountWithAccounts, companiesWithoutAccounts };
}

function classifySocialAccountUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid social account URL: ${rawUrl}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol for social account URL: ${rawUrl}`);
  }

  url.hash = "";
  url.search = "";

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "github.com") return classifyGithubUrl(segments);
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return classifyLinkedinUrl(segments);
  if (host === "x.com" || host === "twitter.com") return classifyXUrl(segments);
  if (host === "instagram.com") return classifyInstagramUrl(segments);
  if (host === "youtube.com" || host === "youtu.be") return classifyYoutubeUrl(host, segments);
  if (host === "reddit.com") return classifyRedditUrl(segments);
  if (host === "producthunt.com") return classifyProductHuntUrl(segments);

  throw new Error(`Unsupported A16Z social account platform: ${rawUrl}`);
}

function classifyGithubUrl(segments) {
  const handle = segments[0]?.toLowerCase() === "orgs" ? segments[1] : segments[0];
  if (!handle || RESERVED_GITHUB_PATHS.has(handle.toLowerCase())) {
    throw new Error(`GitHub URL must point to a user or organization account: ${segments.join("/")}`);
  }

  return {
    platform: "github",
    url: `https://github.com/${handle}`,
    handle
  };
}

function classifyLinkedinUrl(segments) {
  const namespace = segments[0]?.toLowerCase();
  const handle = segments[1];
  if (!["company", "in", "school"].includes(namespace) || !handle) {
    throw new Error(`LinkedIn URL must point to /company, /in, or /school: ${segments.join("/")}`);
  }

  return {
    platform: "linkedin",
    url: `https://www.linkedin.com/${namespace}/${handle}`,
    handle
  };
}

function classifyXUrl(segments) {
  const handle = segments[0]?.replace(/^@/, "");
  if (!handle || RESERVED_X_PATHS.has(handle.toLowerCase())) {
    throw new Error(`X URL must point to an account handle: ${segments.join("/")}`);
  }

  return {
    platform: "x",
    url: `https://x.com/${handle}`,
    handle
  };
}

function classifyInstagramUrl(segments) {
  const handle = segments[0]?.replace(/^@/, "");
  if (!handle || RESERVED_INSTAGRAM_PATHS.has(handle.toLowerCase())) {
    throw new Error(`Instagram URL must point to an account handle: ${segments.join("/")}`);
  }

  return {
    platform: "instagram",
    url: `https://www.instagram.com/${handle}`,
    handle
  };
}

function classifyYoutubeUrl(host, segments) {
  if (host === "youtu.be") {
    throw new Error("YouTube short URLs point to videos, not account channels.");
  }

  const namespace = segments[0]?.toLowerCase();
  const handle = namespace?.startsWith("@") ? segments[0].slice(1) : segments[1];
  if (segments[0]?.startsWith("@")) {
    return {
      platform: "youtube",
      url: `https://www.youtube.com/@${handle}`,
      handle
    };
  }
  if (!["channel", "c", "user"].includes(namespace) || !handle) {
    throw new Error(`YouTube URL must point to /@handle, /channel, /c, or /user: ${segments.join("/")}`);
  }

  return {
    platform: "youtube",
    url: `https://www.youtube.com/${namespace}/${handle}`,
    handle
  };
}

function classifyRedditUrl(segments) {
  const namespace = segments[0]?.toLowerCase();
  const handle = namespace === "r" || namespace === "user" || namespace === "u" ? segments[1] : segments[0];
  if (!handle || RESERVED_REDDIT_PATHS.has(handle.toLowerCase())) {
    throw new Error(`Reddit URL must point to a subreddit or user account: ${segments.join("/")}`);
  }

  const pathNamespace = namespace === "r" || namespace === "user" || namespace === "u" ? namespace : "user";
  return {
    platform: "reddit",
    url: `https://www.reddit.com/${pathNamespace}/${handle}`,
    handle
  };
}

function classifyProductHuntUrl(segments) {
  const namespace = segments[0]?.toLowerCase();
  const handle = segments[0]?.startsWith("@") ? segments[0].slice(1) : segments[1];
  if (segments[0]?.startsWith("@") && handle) {
    return {
      platform: "product_hunt",
      url: `https://www.producthunt.com/@${handle}`,
      handle
    };
  }
  if (!["products", "posts"].includes(namespace) || !handle) {
    throw new Error(`Product Hunt URL must point to /products, /posts, or /@handle: ${segments.join("/")}`);
  }

  return {
    platform: "product_hunt",
    url: `https://www.producthunt.com/${namespace}/${handle}`,
    handle
  };
}

function classifyRssUrl(url) {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.search = "";
  normalized.pathname = normalized.pathname.replace(/\/$/, "");
  const pathHandle = normalized.pathname.split("/").filter(Boolean).join("-");

  return {
    platform: "rss",
    url: normalized.toString(),
    handle: pathHandle ? `${normalized.hostname}-${pathHandle}` : normalized.hostname
  };
}

function isRssUrl(url) {
  const pathname = url.pathname.toLowerCase();
  return (
    /(?:^|\/)(rss|feed|atom)(?:\/|$)/.test(pathname) ||
    pathname.endsWith(".rss") ||
    /(?:^|\/)(rss|feed|atom)\.xml$/.test(pathname)
  );
}

function validateCompanyRoster() {
  const companySlugs = new Set();
  for (const company of SPEEDRUN_COMPANIES) {
    const companySlug = slugify(company.name);
    if (companySlugs.has(companySlug)) throw new Error(`Duplicate company slug: ${companySlug}`);
    companySlugs.add(companySlug);

    const founderSlugs = new Set();
    for (const founderName of company.founders) {
      const founderSlug = slugify(founderName);
      if (founderSlugs.has(founderSlug)) throw new Error(`Duplicate founder slug for ${company.name}: ${founderSlug}`);
      founderSlugs.add(founderSlug);
    }
  }
}

function dedupeAndSortAccounts(accounts) {
  const uniqueAccounts = [
    ...new Map(accounts.map((account) => [`${account.platform}:${account.url.toLowerCase()}`, account])).values()
  ];
  return uniqueAccounts.sort((a, b) => comparePlatforms(a.platform, b.platform) || a.url.localeCompare(b.url));
}

function comparePlatforms(a, b) {
  return PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b);
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
