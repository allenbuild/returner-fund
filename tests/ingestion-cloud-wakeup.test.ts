import { describe, expect, it, vi } from "vitest";
import {
  acceptanceBindingSha256,
  sha256Text
} from "../scripts/lib/ingestion-acceptance-marker.mjs";
import {
  bearerMatches,
  handleCloudIngestionWakeup,
  publicationBundleWakeDecision,
  publicationManifestWakeDecision,
  validateDeployHookUrl
} from "@/lib/ingestion/cloud-wakeup";

const SECRET = "fixture-cron-secret-at-least-32-characters";
const PROJECT_ID = "prj_fixture123";
const HOOK_URL = `https://api.vercel.com/v1/integrations/deploy/${PROJECT_ID}/hook_secret`;
const NOW = new Date("2026-09-07T08:45:00.000Z");
const SLOT_KEY = "central-2026-09-06-1800";
const SCHEDULED_AT = "2026-09-06T23:00:00.000Z";
const EVIDENCE_AT = "2026-09-07T05:47:11.477Z";
const GRAPH_FILENAMES = [
  "s2026.json",
  "s2026-yc-partners.json",
  "s2026-insiders.json",
  "s26.json",
  "s26-yc-partners.json",
  "s26-insiders.json",
  "a16zsr006.json",
  "a16zsr006-yc-partners.json",
  "a16zsr006-insiders.json"
];
const BENCHMARK_FILENAMES = [
  "s2026-score-benchmarks.json",
  "s26-score-benchmarks.json",
  "a16zsr006-score-benchmarks.json"
];

describe("independent cloud ingestion wakeup", () => {
  it("fails closed before network access unless Vercel Cron presents the shared bearer", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const configured = environment();

    await expect(handleCloudIngestionWakeup(request({ authorization: `Bearer ${SECRET}` }), {
      env: configured,
      fetchImpl,
      now: NOW
    })).resolves.toEqual({ body: { status: "unauthorized" }, status: 401 });
    await expect(handleCloudIngestionWakeup(request({
      authorization: "Bearer wrong-secret-with-equal-or-greater-length",
      "user-agent": "vercel-cron/1.0"
    }), { env: configured, fetchImpl, now: NOW })).resolves.toEqual({
      body: { status: "unauthorized" },
      status: 401
    });
    await expect(handleCloudIngestionWakeup(request({
      authorization: `Bearer ${SECRET}`,
      "user-agent": "vercel-cron/1.0"
    }), { env: { ...configured, CRON_SECRET: "short" }, fetchImpl, now: NOW })).resolves.toEqual({
      body: { status: "configuration-error" },
      status: 503
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects cross-project, credential-bearing, redirected, and non-Vercel hook URLs", () => {
    expect(validateDeployHookUrl(HOOK_URL, PROJECT_ID)?.href).toBe(HOOK_URL);
    for (const candidate of [
      "https://attacker.example/v1/integrations/deploy/prj_fixture123/hook_secret",
      "http://api.vercel.com/v1/integrations/deploy/prj_fixture123/hook_secret",
      "https://user:pass@api.vercel.com/v1/integrations/deploy/prj_fixture123/hook_secret",
      "https://api.vercel.com/v1/integrations/deploy/prj_other/hook_secret",
      `${HOOK_URL}?redirect=https://attacker.example`,
      "https://api.vercel.com/v13/deployments"
    ]) expect(validateDeployHookUrl(candidate, PROJECT_ID)).toBeNull();
  });

  it("does not deploy only when both publication data and exact-slot acceptance are current", async () => {
    const bundle = publicationBundle();
    const fetchImpl = stateFetch(bundle);
    const result = await handleCloudIngestionWakeup(authorizedRequest(), {
      env: environment(),
      fetchImpl,
      now: NOW
    });

    expect(result).toEqual({
      body: {
        status: "current",
        reason: "publication-acceptance-current",
        slotKey: SLOT_KEY
      },
      status: 200
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("requests one same-project deployment when the publication watermark is stale", async () => {
    const bundle = publicationBundle({ evidenceCollectedAt: "2026-09-06T22:59:59.000Z" });
    const fetchImpl = stateFetch(bundle)
      .mockResolvedValueOnce(new Response('{"job":{"id":"redacted"}}', { status: 201 }));
    const result = await handleCloudIngestionWakeup(authorizedRequest(), {
      env: environment(),
      fetchImpl,
      now: NOW
    });

    expect(result).toEqual({
      body: {
        status: "wake-requested",
        reason: "publication-watermark-stale",
        slotKey: SLOT_KEY
      },
      status: 202
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[3]?.[0]).toEqual(new URL(HOOK_URL));
    expect(fetchImpl.mock.calls[3]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
  });

  it("wakes for missing, malformed, hash-divergent, or old-slot acceptance", async () => {
    const current = publicationBundle();
    const malformed = "{}\n";
    const hashDivergent = publicationBundle({ receiptSuffix: "\n" });
    const oldSlot = publicationBundle({
      scheduledAt: "2026-09-06T11:00:00.000Z",
      slotKey: "central-2026-09-06-0600"
    });
    const fixtures = [
      { ...current, markerText: null },
      { ...current, markerText: malformed },
      hashDivergent,
      oldSlot
    ];

    for (const bundle of fixtures) {
      const fetchImpl = stateFetch(bundle)
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));
      const result = await handleCloudIngestionWakeup(authorizedRequest(), {
        env: environment(),
        fetchImpl,
        now: NOW
      });
      expect(result).toMatchObject({
        body: { status: "wake-requested", slotKey: SLOT_KEY },
        status: 202
      });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    }
  });

  it("fails closed without a deployment when committed state cannot be fetched", async () => {
    const current = publicationBundle();
    for (const unavailableIndex of [0, 1, 2]) {
      const responses = stateResponses(current);
      responses[unavailableIndex] = new Response("upstream unavailable", { status: 503 });
      const fetchImpl = vi.fn<typeof fetch>();
      for (const response of responses) fetchImpl.mockResolvedValueOnce(response);

      await expect(handleCloudIngestionWakeup(authorizedRequest(), {
        env: environment(),
        fetchImpl,
        now: NOW
      })).resolves.toEqual({ body: { status: "state-unavailable" }, status: 503 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    }
  });

  it("never leaks the deploy-hook response when Vercel rejects a wake request", async () => {
    const bundle = publicationBundle({ evidenceCollectedAt: "2026-09-06T22:59:59.000Z" });
    const fetchImpl = stateFetch(bundle)
      .mockResolvedValueOnce(new Response("secret provider diagnostic", { status: 403 }));

    await expect(handleCloudIngestionWakeup(authorizedRequest(), {
      env: environment(),
      fetchImpl,
      now: NOW
    })).resolves.toEqual({ body: { status: "wake-failed" }, status: 502 });
  });

  it("uses DST-correct 06:00 and 18:00 America/Chicago slot boundaries", () => {
    expect(publicationManifestWakeDecision(
      manifest("2026-07-18T10:59:59.000Z", "2026-07-18T11:00:00.000Z"),
      new Date("2026-07-18T11:05:00.000Z")
    )).toMatchObject({ shouldWake: true, slotKey: "central-2026-07-18-0600" });
    expect(publicationManifestWakeDecision(
      manifest("2026-01-18T12:00:00.000Z", "2026-01-18T12:00:00.000Z"),
      new Date("2026-01-18T12:05:00.000Z")
    )).toMatchObject({ shouldWake: false, slotKey: "central-2026-01-18-0600" });
  });

  it("compares bearer values without accepting prefixes, suffixes, or alternate schemes", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET}suffix`, SECRET)).toBe(false);
    expect(bearerMatches(null, SECRET)).toBe(false);
  });
});

function authorizedRequest() {
  return request({ authorization: `Bearer ${SECRET}`, "user-agent": "vercel-cron/1.0" });
}

function request(headers: Record<string, string>) {
  return new Request("https://www.returner.fund/api/internal/ingestion-wakeup", { headers });
}

function environment() {
  return {
    CRON_SECRET: SECRET,
    VERCEL_INGESTION_DEPLOY_HOOK_URL: HOOK_URL,
    VERCEL_PROJECT_ID: PROJECT_ID
  };
}

type PublicationBundle = {
  manifestText: string | null;
  markerText: string | null;
  receiptText: string | null;
};

function stateFetch(bundle: PublicationBundle) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of stateResponses(bundle)) fetchImpl.mockResolvedValueOnce(response);
  return fetchImpl;
}

function stateResponses(bundle: PublicationBundle) {
  return [
    textResponse(bundle.manifestText),
    textResponse(bundle.markerText),
    textResponse(bundle.receiptText)
  ];
}

function textResponse(value: string | null) {
  return value === null
    ? new Response("not found", { status: 404 })
    : new Response(value, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
}

function publicationBundle({
  evidenceCollectedAt = EVIDENCE_AT,
  scheduledAt = SCHEDULED_AT,
  slotKey = SLOT_KEY,
  receiptSuffix = ""
}: {
  evidenceCollectedAt?: string;
  scheduledAt?: string;
  slotKey?: string;
  receiptSuffix?: string;
} = {}) {
  const manifestText = `${JSON.stringify(manifest(evidenceCollectedAt), null, 2)}\n`;
  const receiptBase = `${JSON.stringify({
    schemaVersion: 1,
    idempotencyKey: slotKey,
    trigger: "schedule",
    scheduledAt,
    evidenceCollectedAt
  }, null, 2)}\n`;
  const receiptText = `${receiptBase}${receiptSuffix}`;
  const marker: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "autonomous-ingestion-publication-acceptance",
    slotKey,
    scheduledAt,
    acceptedAt: "2026-09-07T06:20:00.000Z",
    publicationCommit: "a".repeat(40),
    publicationSourceSha: "b".repeat(40),
    publicationRunId: "12345",
    publicationRunAttempt: "1",
    receiptPath: "outputs/ingestion-source-delta-current.json",
    receiptSha256: sha256Text(receiptBase),
    manifestPath: "public/graph/manifest.json",
    manifestSha256: sha256Text(manifestText),
    manifestContentHash: "b".repeat(64),
    evidenceCollectedAt,
    validation: {
      validatedSha: "c".repeat(40),
      workflowRunId: "12346",
      workflowRunAttempt: "1"
    }
  };
  marker.bindingSha256 = acceptanceBindingSha256(marker);
  return { manifestText, markerText: `${JSON.stringify(marker, null, 2)}\n`, receiptText };
}

function manifest(evidenceCollectedAt: string, publishedAt = "2026-09-07T06:08:07.220Z") {
  const artifact = (filename: string) => ({
    filename,
    generatedAt: publishedAt,
    byteSize: 123,
    sha256: "a".repeat(64)
  });
  return {
    schemaVersion: 2,
    publishedAt,
    ingestionRunId: "fixture-ingestion-run",
    evidenceCollectedAt,
    evidenceCollectedAtKind: "accepted-full-collection",
    contentHash: "b".repeat(64),
    graphArtifacts: GRAPH_FILENAMES.map(artifact),
    benchmarkArtifacts: BENCHMARK_FILENAMES.map(artifact)
  };
}
