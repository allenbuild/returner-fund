import { describe, expect, it } from "vitest";
import { importDurableEvidence } from "../scripts/lib/durable-evidence-import.mjs";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const COMPANY_ID = "00000000-0000-0000-0000-000000000002";
const FOUNDER_ID = "00000000-0000-0000-0000-000000000003";

describe("durable evidence import", () => {
  it("canonicalizes and deduplicates public rows while retaining rejected context", async () => {
    const client = new FakeSupabaseClient();
    const snapshot = {
      source: { label: "Public collector", fetchedAt: "2026-07-18T12:00:00Z" },
      evidence: [
        {
          id: "post-one",
          entityType: "company",
          entityId: "company-acme",
          companySlug: "acme",
          platform: "twitter",
          sourceUrl: "http://mobile.twitter.com/Acme/status/123/photo/1?utm_source=feed#reply",
          platformPostId: "123",
          title: "Launch",
          text: "We launched.",
          postedAt: "2026-07-17T18:00:00Z",
          metrics: { views: 100, likes: 4 },
          review_state: "verified",
          matchReason: "Official company account."
        },
        {
          id: "post-one-copy",
          entityType: "company",
          entityId: "company-acme",
          companySlug: "acme",
          platform: "x",
          sourceUrl: "https://x.com/another_handle/status/123?ref=share",
          metrics: { views: 100, likes: 4 },
          review_state: "verified",
          matchReason: "Same native post."
        },
        {
          id: "profile",
          entityType: "company",
          entityId: "company-acme",
          companySlug: "acme",
          platform: "x",
          sourceUrl: "https://x.com/Acme?utm_campaign=profile",
          metrics: { followers: 9000 },
          review_state: "verified",
          matchReason: "Official profile, context only."
        }
      ]
    };

    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { companies: new Map([["company-acme", COMPANY_ID]]) },
      snapshots: [snapshot]
    });

    expect(result).toMatchObject({
      received: 3,
      rejected: 1,
      duplicates: 1,
      stored: 2,
      readBack: 2,
      attributions: { stored: 2, duplicates: 1, unresolved: 0 },
      metricObservations: { stored: 2, duplicates: 2 }
    });

    const post = client.table("evidence_items").find((row) => row.evidence_kind === "post");
    const profile = client.table("evidence_items").find((row) => row.evidence_kind === "account");
    expect(post).toMatchObject({
      platform: "x",
      canonical_key: "x:post:123",
      platform_object_id: "123",
      canonical_url: "https://x.com/acme/status/123"
    });
    expect(profile).toMatchObject({
      canonical_url: "https://x.com/Acme",
      metadata_json: {
        url_classification: "profile",
        traction_eligible: false,
        rejection_reasons: ["profile_page"]
      }
    });
    expect(client.table("metric_observations").map((row) => row.metric_name).sort()).toEqual(["likes", "views"]);
    expect(client.table("evidence_attributions").find((row) => row.evidence_id === profile.id)).toMatchObject({
      review_state: "verified",
      risk_level: "low",
      score_eligible: false
    });

    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { companies: { "company-acme": COMPANY_ID } },
      publicSnapshot: snapshot
    });
    expect(client.table("evidence_items")).toHaveLength(2);
    expect(client.table("evidence_attributions")).toHaveLength(2);
    expect(client.table("metric_observations")).toHaveLength(2);
  });

  it("imports GitHub accounts as context and repositories as native metric evidence", async () => {
    const client = new FakeSupabaseClient();
    const snapshot = {
      source: { label: "GitHub public API", fetchedAt: "2026-07-18T13:00:00Z" },
      accounts: [
        {
          entityType: "founder",
          entityId: "founder-acme-alice",
          companySlug: "acme",
          companyName: "Acme",
          sourceUrl: "https://example.com/founders/alice?utm_source=catalog",
          githubUrl: "https://github.com/ExampleOrg",
          discoverySource: "yc_profile",
          matchReason: "GitHub URL on the founder profile.",
          login: "ExampleOrg",
          fetched: true,
          account: {
            login: "ExampleOrg",
            htmlUrl: "https://www.github.com/ExampleOrg?tab=repositories",
            followers: 50,
            publicRepos: 1
          },
          aggregate: { totalStars: 12, profileScore: 80 },
          repos: [
            {
              id: 42,
              name: "Returner",
              fullName: "ExampleOrg/Returner",
              htmlUrl: "https://www.github.com/ExampleOrg/Returner.git/tree/main?utm_campaign=launch#readme",
              description: "Evidence importer",
              stars: 12,
              forks: 3,
              watchers: 12,
              openIssues: 1,
              score: 99,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-07-18T10:00:00Z"
            }
          ]
        }
      ]
    };

    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { founderByEntityId: new Map([["founder-acme-alice", { id: FOUNDER_ID }]]) },
      githubSnapshots: [snapshot]
    });

    expect(result).toMatchObject({ received: 2, rejected: 1, duplicates: 0, stored: 2, readBack: 2 });
    expect(client.table("evidence_items")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidence_kind: "account",
        canonical_key: "github:account:exampleorg",
        canonical_url: "https://github.com/ExampleOrg?tab=repositories",
        platform_object_id: "exampleorg",
        metadata_json: expect.objectContaining({ rejection_reasons: ["profile_page"] })
      }),
      expect.objectContaining({
        evidence_kind: "repository",
        canonical_key: "github:repository:exampleorg/returner",
        canonical_url: "https://github.com/exampleorg/returner",
        platform_object_id: "exampleorg/returner"
      })
    ]));
    expect(client.table("metric_observations").map((row) => row.metric_name).sort()).toEqual([
      "forks", "open_issues", "stars", "watchers"
    ]);
    expect(client.table("evidence_attributions")).toHaveLength(2);
    expect(client.table("evidence_attributions").every((row) => row.founder_id === FOUNDER_ID)).toBe(true);
  });

  it("keeps search, generic context, and conflicting IDs out of traction with reasons", async () => {
    const client = new FakeSupabaseClient();
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { companyIdsBySlug: { acme: COMPANY_ID } },
      snapshot: {
        source: { fetchedAt: "2026-07-18T14:00:00Z" },
        evidence: [
          {
            entityType: "company",
            companySlug: "acme",
            platform: "youtube",
            sourceUrl: "https://youtube.com/results?search_query=acme&utm_source=feed",
            metrics: { views: 100 },
            review_state: "verified",
            matchReason: "Search context."
          },
          {
            entityType: "company",
            companySlug: "acme",
            platform: "web",
            sourceUrl: "https://example.com/acme?utm_campaign=launch",
            metrics: { views: 100 },
            review_state: "verified",
            matchReason: "Web context."
          },
          {
            entityType: "company",
            companySlug: "acme",
            platform: "x",
            sourceUrl: "https://x.com/acme/status/456",
            platformPostId: "123",
            metrics: { likes: 10 },
            review_state: "verified",
            matchReason: "Conflicting native ID."
          }
        ]
      }
    });

    expect(result).toMatchObject({ received: 3, rejected: 3, duplicates: 0, stored: 3, readBack: 3 });
    expect(client.table("metric_observations")).toHaveLength(0);
    expect(client.table("evidence_items").map((row) => row.metadata_json.rejection_reasons)).toEqual(
      expect.arrayContaining([
        ["search_page"],
        ["context_only_platform"],
        ["native_id_conflict"]
      ])
    );
    expect(client.table("evidence_attributions").every((row) => row.score_eligible === false)).toBe(true);
  });

  it.each(["evidence_items", "evidence_attributions", "metric_observations"])(
    "surfaces every %s database error",
    async (failedTable) => {
      const client = new FakeSupabaseClient(failedTable);
      const promise = importDurableEvidence({
        client,
        ingestionRunId: RUN_ID,
        catalogMaps: { companies: { "company-acme": COMPANY_ID } },
        snapshots: [{
          source: { fetchedAt: "2026-07-18T12:00:00Z" },
          evidence: [{
            entityType: "company",
            entityId: "company-acme",
            platform: "x",
            sourceUrl: "https://x.com/acme/status/123",
            metrics: { likes: 1 },
            review_state: "verified",
            matchReason: "Verified account."
          }]
        }]
      });

      await expect(promise).rejects.toThrow(`${failedTable} denied (42501)`);
    }
  );
});

class FakeSupabaseClient {
  constructor(failedTable = null) {
    this.failedTable = failedTable;
    this.tables = new Map([
      ["evidence_items", []],
      ["evidence_attributions", []],
      ["metric_observations", []]
    ]);
    this.calls = [];
    this.nextId = 1;
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  table(name) {
    return this.tables.get(name);
  }

  execute(query) {
    this.calls.push({
      table: query.table,
      operation: query.operation,
      values: structuredClone(query.values),
      options: structuredClone(query.options),
      select: query.selected
    });
    if (query.table === this.failedTable) {
      return { data: null, error: { message: `${query.table} denied`, code: "42501" } };
    }

    const table = this.table(query.table);
    const rows = Array.isArray(query.values) ? query.values : [query.values];
    const conflicts = String(query.options?.onConflict ?? "id").split(",");
    const returned = [];
    for (const value of rows) {
      const existing = table.find((row) => conflicts.every((key) => row[key] === value[key]));
      if (existing && query.options?.ignoreDuplicates) continue;
      if (existing) {
        Object.assign(existing, structuredClone(value));
        returned.push(existing);
      } else {
        const row = { id: value.id ?? fakeUuid(this.nextId++), ...structuredClone(value) };
        table.push(row);
        returned.push(row);
      }
    }
    return { data: query.selected ? returned.map((row) => selectRow(row, query.selected)) : returned, error: null };
  }
}

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.operation = null;
    this.values = null;
    this.options = null;
    this.selected = null;
  }

  upsert(values, options) {
    this.operation = "upsert";
    this.values = values;
    this.options = options;
    return this;
  }

  select(columns) {
    this.selected = columns;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.client.execute(this)).then(resolve, reject);
  }
}

function selectRow(row, columns) {
  return Object.fromEntries(columns.split(",").map((column) => column.trim()).map((column) => [column, row[column]]));
}

function fakeUuid(value) {
  return `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
}
