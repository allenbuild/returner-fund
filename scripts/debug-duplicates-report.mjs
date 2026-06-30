import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1";
const graph = await fetchJson(apiUrl);
const groups = new Map();

for (const item of graph.evidence) {
  const key = canonicalEvidenceKey(item);
  groups.set(key, [...(groups.get(key) ?? []), item]);
}

const duplicates = [...groups.entries()]
  .filter(([, items]) => items.length > 1)
  .map(([key, items]) => ({
    key,
    platform: items[0].platform,
    evidence_ids: items.map((item) => item.id),
    urls: [...new Set(items.map((item) => item.sourceUrl))],
    latest_checked_at: latestDate(items.map((item) => item.last_checked_at)),
    platform_post_ids: [...new Set(items.map((item) => item.platformPostId).filter(Boolean))]
  }));
const duplicateAccountGroups = findDuplicateSocialAccounts(graph);

const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  duplicate_group_count: duplicates.length,
  duplicate_evidence_count: duplicates.reduce((sum, item) => sum + item.evidence_ids.length, 0),
  groups: duplicates,
  duplicate_account_group_count: duplicateAccountGroups.length,
  duplicate_account_groups: duplicateAccountGroups
};

const outputPath = path.join("outputs", "duplicates-debug-s2026.json");
await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, duplicateGroups: duplicates.length, duplicateAccountGroups: duplicateAccountGroups.length }, null, 2));

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Graph API failed with ${response.status}`);
  }
  return response.json();
}

function canonicalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|igshid$|mc_|ref$|ref_src$|s$|t$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com") url.hostname = "x.com";
    if (url.hostname === "x.com") {
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
      if (match) {
        url.pathname = `/${match[1].toLowerCase()}/status/${match[2]}`;
        url.search = "";
      }
    }
    if (url.hostname === "instagram.com") {
      const match = url.pathname.match(/^\/(p|reel|tv)\/([^/]+)/i);
      if (match) {
        url.pathname = `/${match[1].toLowerCase()}/${match[2]}`;
        url.search = "";
      }
    }
    if (url.hostname.endsWith("linkedin.com")) {
      url.search = "";
      url.pathname = url.pathname.replace(/\/$/, "");
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function canonicalEvidenceKey(item) {
  if (item.platformPostId) {
    return `${item.platform}:post:${normalizeKeyPart(item.platformPostId)}`;
  }

  const url = canonicalUrl(item.sourceUrl);
  if (url) {
    return `${item.platform}:url:${url}`;
  }

  const accountPart = item.canonicalAccountId ?? item.socialAccountId ?? item.authorHandle ?? item.authorName;
  return `${item.platform}:fallback:${normalizeKeyPart(accountPart)}:${fallbackKey(item)}`;
}

function fallbackKey(item) {
  return `${item.authorName}:${item.text}`.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizeKeyPart(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function latestDate(values) {
  return values
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function findDuplicateSocialAccounts(graph) {
  const groups = new Map();

  for (const node of graph.nodes) {
    const rows = [
      ...(node.socialAccounts ?? []).map((account) => ({
        company_id: node.entityId,
        company_name: node.label,
        entity_name: node.label,
        entity_type: "company",
        account
      })),
      ...(node.founders ?? []).flatMap((founder) =>
        (founder.socialAccounts ?? []).map((account) => ({
          company_id: node.entityId,
          company_name: node.label,
          entity_name: founder.name,
          entity_type: "founder",
          account
        }))
      )
    ];

    for (const row of rows) {
      const key = `${row.company_id}:${row.account.platform}:${canonicalAccountPart(row.account.url, row.account.handle)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }

  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      key,
      company_id: rows[0].company_id,
      company_name: rows[0].company_name,
      platform: rows[0].account.platform,
      account_ids: rows.map((row) => row.account.id),
      urls: [...new Set(rows.map((row) => row.account.url))],
      handles: [...new Set(rows.map((row) => row.account.handle).filter(Boolean))],
      entity_names: [...new Set(rows.map((row) => `${row.entity_name} (${row.entity_type})`))]
    }));
}

function canonicalAccountPart(url, handle) {
  const canonical = canonicalAccountUrl(url);
  return canonical || String(handle ?? "").toLowerCase().replace(/^@/, "").trim();
}

function canonicalAccountUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com") {
      url.hostname = "x.com";
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return "";
  }
}
