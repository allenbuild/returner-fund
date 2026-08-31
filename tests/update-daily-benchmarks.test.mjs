import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  BATCH_SNAPSHOTS,
  appendObservedBenchmarkSnapshot,
  fetchGraph,
  getGraphApiServer,
  inheritCanonicalAudienceSnapshotState,
  main,
  publishBenchmarkSnapshots,
  scheduledUtcHourRepresentsCentralMidnight,
  validateGraphSnapshots
} from "../scripts/update-daily-benchmarks.mjs";

describe("daily benchmark updater", () => {
  it.each([
    {
      boundary: "winter standard time",
      runStartedAt: "2026-01-16T18:00:00.000Z",
      activeUtcHour: 6
    },
    {
      boundary: "the day before the spring transition",
      runStartedAt: "2026-03-07T18:00:00.000Z",
      activeUtcHour: 6
    },
    {
      boundary: "the spring transition day",
      runStartedAt: "2026-03-08T18:00:00.000Z",
      activeUtcHour: 6
    },
    {
      boundary: "the day after the spring transition",
      runStartedAt: "2026-03-09T18:00:00.000Z",
      activeUtcHour: 5
    },
    {
      boundary: "summer daylight time",
      runStartedAt: "2026-07-16T18:00:00.000Z",
      activeUtcHour: 5
    },
    {
      boundary: "the day before the fall transition",
      runStartedAt: "2026-10-31T18:00:00.000Z",
      activeUtcHour: 5
    },
    {
      boundary: "the fall transition day",
      runStartedAt: "2026-11-01T18:00:00.000Z",
      activeUtcHour: 5
    },
    {
      boundary: "the first 05:00 UTC slot after the fall transition",
      runStartedAt: "2026-11-02T05:00:00.000Z",
      activeUtcHour: 6
    }
  ])("selects exactly one Central-midnight UTC slot on $boundary", ({
    runStartedAt,
    activeUtcHour
  }) => {
    const decisions = [5, 6].map((scheduledUtcHour) =>
      scheduledUtcHourRepresentsCentralMidnight(new Date(runStartedAt), scheduledUtcHour)
    );

    expect(decisions).toEqual([activeUtcHour === 5, activeUtcHour === 6]);
    expect(decisions.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    { staleField: "recordedAt", staleBatch: "S26", staleInputBatch: undefined },
    { staleField: "inputGeneratedAt", staleBatch: undefined, staleInputBatch: "S26" }
  ])("fails an inactive DST slot when canonical v4 $staleField is stale", async ({
    staleBatch,
    staleInputBatch
  }) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-stale-skip-"));
    writeSkipHistories(rootDir, {
      recordedAt: new Date("2026-07-16T05:05:00.000Z"),
      staleBatch,
      staleInputBatch
    });

    await expect(
      main(
        ["--now=2026-07-16T06:05:00.000Z", "--scheduled-utc-hour=6"],
        { rootDir }
      )
    ).rejects.toThrow(/refusing to skip stale daily benchmark update.*S26/i);
  });

  it.each([
    {
      season: "summer",
      now: "2026-07-16T06:05:00.000Z",
      recordedAt: "2026-07-16T05:05:00.000Z",
      scheduledUtcHour: 6
    },
    {
      season: "winter",
      now: "2026-01-16T05:05:00.000Z",
      recordedAt: "2026-01-15T06:05:00.000Z",
      scheduledUtcHour: 5
    },
    {
      season: "first post-fall 05:00 UTC",
      now: "2026-11-02T05:00:00.000Z",
      recordedAt: "2026-11-01T05:05:00.000Z",
      scheduledUtcHour: 5
    }
  ])("skips an inactive $season slot after all canonical v4 histories are current", async ({
    now,
    recordedAt,
    scheduledUtcHour
  }) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-current-skip-"));
    writeSkipHistories(rootDir, {
      recordedAt: new Date(recordedAt)
    });

    await expect(
      main(
        [`--now=${now}`, `--scheduled-utc-hour=${scheduledUtcHour}`],
        { rootDir }
      )
    ).resolves.toEqual({ status: "skipped" });
  });

  it("accepts snapshots generated during the build that precedes the publisher process", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-build-window-"));
    const fixtureServer = createGraphFixtureServer({ failAfterReady: false });
    await listenOnRandomPort(fixtureServer);
    const address = fixtureServer.address();
    const child = new FakeChildProcess();

    try {
      await expect(
        main(
          [
            `--port=${address.port}`,
            "--now=2026-07-16T05:02:00.000Z",
            "--window-start=2026-07-16T05:00:00.000Z"
          ],
          {
            rootDir,
            graphServerOptions: graphServerTestOptions(child)
          }
        )
      ).resolves.toMatchObject({ status: "updated" });
    } finally {
      await closeServer(fixtureServer);
    }
  });

  it("uses the in-process provider without starting a local Next server", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-in-process-"));
    const generatedAt = new Date("2026-07-16T05:01:00.000Z");
    const graphs = new Map(graphSnapshots(generatedAt).map(({ descriptor, graph }) => [
      `${descriptor.slug}:${descriptor.topVoices ?? "off"}`,
      graph
    ]));
    const calls = [];
    let finished = false;

    try {
      await expect(
        main(
          [
            "--pinned-source-in-process",
            "--now=2026-07-16T05:02:00.000Z",
            "--window-start=2026-07-16T05:00:00.000Z"
          ],
          {
            rootDir,
            graphServerOptions: {
              spawnImpl: () => {
                throw new Error("The in-process provider must not start a Next server.");
              }
            },
            graphSnapshotProvider: {
              async fetchGraph(batchSlug, topVoices) {
                calls.push({ batchSlug, topVoices: topVoices ?? "off" });
                return graphs.get(`${batchSlug}:${topVoices ?? "off"}`);
              },
              async finish() {
                finished = true;
              }
            }
          }
        )
      ).resolves.toMatchObject({ status: "updated", baseUrl: "pinned-source-in-process" });
      expect(calls).toEqual(BATCH_SNAPSHOTS.map((descriptor) => ({
        batchSlug: descriptor.slug,
        topVoices: descriptor.topVoices ?? "off"
      })));
      expect(finished).toBe(true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("validates the exact v4 scoring model and coherent generated/input timestamps", () => {
    const generatedAt = new Date("2026-07-16T05:00:10.000Z");
    const snapshots = graphSnapshots(generatedAt);

    expect(
      validateGraphSnapshots(snapshots, {
        now: new Date("2026-07-16T05:01:00.000Z"),
        windowStart: new Date("2026-07-16T05:00:00.000Z")
      })
    ).toEqual({ scoringModelId: "returner-traction", scoringModelVersion: "4.3.0" });

    snapshots[8].graph.scoringContext.modelVersion = "5.0.0";
    snapshots[8].graph.nodes.forEach((node) => {
      node.scoreBreakdown.modelVersion = "5.0.0";
    });
    expect(() =>
      validateGraphSnapshots(snapshots, {
        now: new Date("2026-07-16T05:01:00.000Z"),
        windowStart: new Date("2026-07-16T05:00:00.000Z")
      })
    ).toThrow(/returner-traction@4\.3\.0/i);

    const consistentlyLegacySnapshots = graphSnapshots(generatedAt);
    for (const snapshot of consistentlyLegacySnapshots) {
      snapshot.graph.scoringContext.modelId = "traction-score";
      snapshot.graph.nodes.forEach((node) => {
        node.scoreBreakdown.modelId = "traction-score";
      });
    }
    expect(() =>
      validateGraphSnapshots(consistentlyLegacySnapshots, {
        now: new Date("2026-07-16T05:01:00.000Z"),
        windowStart: new Date("2026-07-16T05:00:00.000Z")
      })
    ).toThrow(/returner-traction@4\.3\.0/i);
  });

  it("rejects audience node state that drifts from the canonical base snapshot", () => {
    const generatedAt = new Date("2026-07-16T05:00:10.000Z");
    const snapshots = graphSnapshots(generatedAt);
    snapshots[1].graph.nodes[0].radius = 99;

    expect(() =>
      validateGraphSnapshots(snapshots, {
        now: new Date("2026-07-16T05:01:00.000Z"),
        windowStart: new Date("2026-07-16T05:00:00.000Z")
      })
    ).toThrow(/changes canonical node company-1 field radius/i);
  });

  it("inherits benchmark momentum from the base snapshot without mutating the fetched set", () => {
    const snapshots = graphSnapshots(new Date("2026-07-16T05:00:10.000Z"));
    const canonicalMomentum = {
      ...snapshots[0].graph.fastestGaining[0],
      dod: {
        scoreDelta: 10,
        percentDelta: 12.5,
        rankDelta: 1,
        currentScore: 90,
        currentRank: 1,
        baselineScore: 80,
        baselineRank: 2,
        benchmarkedAt: "2026-07-15T05:01:00.000Z"
      }
    };
    snapshots[0].graph.fastestGaining[0] = canonicalMomentum;

    const inherited = inheritCanonicalAudienceSnapshotState(snapshots);

    expect(inherited[1].graph.fastestGaining).toEqual([canonicalMomentum]);
    expect(inherited[2].graph.fastestGaining).toEqual([canonicalMomentum]);
    expect(snapshots[1].graph.fastestGaining).not.toEqual([canonicalMomentum]);
    expect(inherited[1].graph.nodes).toBe(snapshots[1].graph.nodes);
    expect(inherited[1].graph.leaderboard).toBe(snapshots[1].graph.leaderboard);
  });

  it("rejects the whole set before staging when any of the nine snapshots is invalid", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-invalid-"));
    const sentinelPath = path.join(rootDir, "public", "graph", "s2026.json");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "sentinel\n", "utf8");
    const generatedAt = new Date("2026-07-16T05:00:10.000Z");
    const snapshots = graphSnapshots(generatedAt);
    snapshots[7].graph.scoringContext.responseBuiltAt = "2026-07-16T05:00:11.000Z";

    await expect(
      publishBenchmarkSnapshots(snapshots, {
        rootDir,
        recordedAt: new Date("2026-07-16T05:01:00.000Z"),
        validationNow: new Date("2026-07-16T05:01:00.000Z"),
        windowStart: new Date("2026-07-16T05:00:00.000Z")
      })
    ).rejects.toThrow(/responseBuiltAt.*equal generatedAt|generatedAt does not match/i);

    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("sentinel\n");
    expect(fs.readdirSync(path.dirname(sentinelPath))).toEqual(["s2026.json"]);
    expect(fs.existsSync(path.join(rootDir, "outputs"))).toBe(false);
  });

  it("rejects a Central-midnight rollover before writing any graph or history", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-central-rollover-"));
    const sentinelPath = path.join(rootDir, "public", "graph", "s2026.json");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "sentinel\n", "utf8");
    const recordedAt = new Date("2026-07-17T05:01:00.000Z");

    await expect(
      publishBenchmarkSnapshots(graphSnapshots(new Date("2026-07-17T05:00:10.000Z")), {
        rootDir,
        recordedAt,
        validationNow: recordedAt,
        windowStart: new Date("2026-07-17T05:00:00.000Z"),
        expectedCentralDate: "2026-07-16"
      })
    ).rejects.toThrow(/Central date changed before publication.*expected 2026-07-16.*2026-07-17/i);

    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("sentinel\n");
    expect(fs.readdirSync(path.dirname(sentinelPath))).toEqual(["s2026.json"]);
    expect(fs.existsSync(path.join(rootDir, "outputs"))).toBe(false);
  });

  it.each(["2026-02-29", "2026-02-30", "2026-2-03", "not-a-date"])
    ("rejects malformed expected Central date %s before fetching", async (expectedCentralDate) => {
      let fetched = false;

      await expect(
        main([`--expected-central-date=${expectedCentralDate}`], {
          fetchGraphImpl: async () => {
            fetched = true;
            throw new Error("fetch should not run");
          }
        })
      ).rejects.toThrow(/Invalid expected Central date.*real YYYY-MM-DD/i);

      expect(fetched).toBe(false);
    });

  it("rejects contradictory v4 scoring state before publication", () => {
    const generatedAt = new Date("2026-07-16T05:00:10.000Z");
    const snapshots = graphSnapshots(generatedAt);
    snapshots[4].graph.nodes[0].scoreBreakdown.totalScore = 8;

    expect(() =>
      validateGraphSnapshots(snapshots, {
        now: new Date("2026-07-16T05:01:00.000Z"),
        windowStart: new Date("2026-07-16T05:00:00.000Z")
      })
    ).toThrow(/nodes\[0\]\.score.*scoreBreakdown\.totalScore/i);
  });

  it("rejects all nine atomically when one company breakdown is incomplete", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-v4-contract-"));
    const sentinelPath = path.join(rootDir, "public", "graph", "s2026.json");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "sentinel\n", "utf8");
    const generatedAt = new Date("2026-07-16T05:00:10.000Z");
    const snapshots = graphSnapshots(generatedAt);
    delete snapshots[8].graph.nodes[0].scoreBreakdown.calibration;

    await expect(
      publishBenchmarkSnapshots(snapshots, {
        rootDir,
        recordedAt: new Date("2026-07-16T05:01:00.000Z"),
        validationNow: new Date("2026-07-16T05:01:00.000Z"),
        windowStart: new Date("2026-07-16T05:00:00.000Z")
      })
    ).rejects.toThrow(/complete returner-traction@4\.3\.0 score breakdown/i);

    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("sentinel\n");
    expect(fs.readdirSync(path.dirname(sentinelPath))).toEqual(["s2026.json"]);
    expect(fs.existsSync(path.join(rootDir, "outputs"))).toBe(false);
  });

  it("publishes all nine graphs and three append-only histories after validation", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-valid-"));
    const generatedAt = new Date("2026-07-16T05:00:10.000Z");
    const recordedAt = new Date("2026-07-16T05:01:00.000Z");
    const snapshots = graphSnapshots(generatedAt);
    const legacySnapshot = {
      recordedAt: "2026-07-15T05:01:00.000Z",
      legacyMarker: "preserve-me",
      companies: [{ companyId: "legacy", companyName: "Legacy", score: 1, rank: 99 }]
    };

    for (const slug of ["s2026", "s26", "a16zsr006"]) {
      const historyPath = path.join(rootDir, "outputs", "benchmarks", `${slug}-score-benchmarks.json`);
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      fs.writeFileSync(
        historyPath,
        `${JSON.stringify({
          version: 1,
          batchSlug: slug === "a16zsr006" ? "A16ZSR006" : slug.toUpperCase(),
          updatedAt: legacySnapshot.recordedAt,
          daily: [legacySnapshot],
          weekly: []
        }, null, 2)}\n`,
        "utf8"
      );
    }

    const result = await publishBenchmarkSnapshots(snapshots, {
      rootDir,
      recordedAt,
      validationNow: recordedAt,
      windowStart: new Date("2026-07-16T05:00:00.000Z"),
      expectedCentralDate: "2026-07-16"
    });

    expect(result.writtenFiles.filter((file) => file.kind === "graph")).toHaveLength(9);
    expect(result.writtenFiles.filter((file) => file.kind === "history")).toHaveLength(3);
    for (const descriptor of BATCH_SNAPSHOTS) {
      const graphPath = path.join(rootDir, "public", "graph", descriptor.filename);
      const publishedGraph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
      expect(publishedGraph.batch.slug).toBe(descriptor.slug);
      expect(publishedGraph.scoringContext).toEqual(expect.objectContaining({
        scoreScope: "all_platforms",
        selectedPlatforms: []
      }));
      if (descriptor.topVoices) {
        expect(publishedGraph.leaderboard[0]).toEqual(expect.objectContaining({ score: 86, rank: 1 }));
      }
    }
    for (const slug of ["s2026", "s26", "a16zsr006"]) {
      const history = JSON.parse(
        fs.readFileSync(path.join(rootDir, "outputs", "benchmarks", `${slug}-score-benchmarks.json`), "utf8")
      );
      expect(history.daily[0]).toEqual(legacySnapshot);
      expect(history.daily[1]).toMatchObject({
        recordedAt: recordedAt.toISOString(),
        scoringModelVersion: "4.3.0",
        inputGeneratedAt: generatedAt.toISOString()
      });
    }
  });

  it("keeps old entries untouched and appends a second same-day observation for a new model", () => {
    const recordedAt = new Date("2026-07-16T05:01:00.000Z");
    const legacy = {
      recordedAt: recordedAt.toISOString(),
      scoringModelVersion: "3.0.0",
      inputGeneratedAt: "2026-07-16T05:00:00.000Z",
      marker: "old-model",
      companies: [{ companyId: "one", companyName: "One", score: 1, rank: 1 }]
    };
    const store = {
      version: 1,
      batchSlug: "S2026",
      updatedAt: legacy.recordedAt,
      daily: [legacy],
      weekly: []
    };
    const graph = graphFor(BATCH_SNAPSHOTS[0], new Date("2026-07-16T05:00:10.000Z"));

    const next = appendObservedBenchmarkSnapshot(store, graph, recordedAt);

    expect(next.daily[0]).toEqual(legacy);
    expect(next.daily).toHaveLength(2);
    expect(next.daily[1].scoringModelVersion).toBe("4.3.0");
  });

  it("repairs a same-day entry whose graph input belongs to the previous Central day", () => {
    const recordedAt = new Date("2026-07-17T05:05:00.000Z");
    const stale = {
      recordedAt: recordedAt.toISOString(),
      scoringModelVersion: "4.3.0",
      inputGeneratedAt: "2026-07-17T04:59:59.000Z",
      companies: [{ companyId: "stale", companyName: "Stale", score: 1, rank: 1 }]
    };
    const store = {
      version: 1,
      batchSlug: "S2026",
      updatedAt: stale.recordedAt,
      daily: [stale],
      weekly: []
    };
    const graph = graphFor(BATCH_SNAPSHOTS[0], new Date("2026-07-17T05:04:00.000Z"));

    const next = appendObservedBenchmarkSnapshot(store, graph, recordedAt);

    expect(next.daily).toHaveLength(1);
    expect(next.daily[0]).toMatchObject({
      recordedAt: recordedAt.toISOString(),
      inputGeneratedAt: "2026-07-17T05:04:00.000Z",
      scoringModelVersion: "4.3.0"
    });
    expect(next.daily[0]).not.toEqual(stale);
  });

  it("refreshes a same-day entry when autonomous ingestion publishes a newer graph", () => {
    const previousRecordedAt = new Date("2026-08-26T10:02:26.841Z");
    const recordedAt = new Date("2026-08-26T12:14:24.397Z");
    const previous = {
      recordedAt: previousRecordedAt.toISOString(),
      scoringModelVersion: "4.3.0",
      inputGeneratedAt: "2026-08-26T10:01:00.000Z",
      companies: [{ companyId: "old", companyName: "Old", score: 1, rank: 1 }]
    };
    const store = {
      version: 1,
      batchSlug: "S2026",
      updatedAt: previousRecordedAt.toISOString(),
      daily: [previous],
      weekly: [previous]
    };
    const newerGraph = graphFor(BATCH_SNAPSHOTS[0], new Date("2026-08-26T12:13:26.086Z"));

    const refreshed = appendObservedBenchmarkSnapshot(store, newerGraph, recordedAt);

    expect(refreshed.updatedAt).toBe(recordedAt.toISOString());
    expect(refreshed.daily).toHaveLength(1);
    expect(refreshed.daily[0]).toMatchObject({
      recordedAt: recordedAt.toISOString(),
      inputGeneratedAt: "2026-08-26T12:13:26.086Z",
      scoringModelVersion: "4.3.0"
    });
    expect(refreshed.daily[0]).not.toEqual(previous);

    const olderGraph = graphFor(BATCH_SNAPSHOTS[0], new Date("2026-08-26T09:59:00.000Z"));
    expect(appendObservedBenchmarkSnapshot(store, olderGraph, recordedAt)).toBe(store);
  });

  it("aborts a graph fetch that exceeds its timeout", async () => {
    const server = http.createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}\n");
      }, 200);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    try {
      await expect(
        fetchGraph(`http://127.0.0.1:${address.port}`, "S2026", undefined, { timeoutMs: 20 })
      ).rejects.toThrow(/timed out/i);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("sends the per-run publication token only when explicitly supplied", async () => {
    const received = [];
    const server = http.createServer((request, response) => {
      received.push({
        publicationToken: request.headers["x-returner-publication-build"],
        authorization: request.headers.authorization,
        url: request.url
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await fetchGraph(baseUrl, "S2026", undefined, {
        publicationToken: "per-run-secret-token"
      });
      await fetchGraph(baseUrl, "S2026");
      await fetchGraph(baseUrl, "S2026", undefined, {
        diagnosticsSecret: "diagnostics-secret"
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(received).toEqual([
      {
        publicationToken: "per-run-secret-token",
        authorization: undefined,
        url: "/api/graph/full?batch=S2026&includeNonScoring=true"
      },
      {
        publicationToken: undefined,
        authorization: undefined,
        url: "/api/graph/full?batch=S2026&includeNonScoring=true"
      },
      {
        publicationToken: undefined,
        authorization: "Bearer diagnostics-secret",
        url: "/api/graph/full?batch=S2026&includeNonScoring=true"
      }
    ]);
  });

  it("injects a high-entropy publication token only into its loopback child", async () => {
    const child = new FakeChildProcess();
    const parentToken = process.env.GRAPH_PUBLICATION_BUILD_TOKEN;
    let spawnOptions;
    const server = getGraphApiServer(
      { port: 3212 },
      graphServerTestOptions(child, {
        env: { SAFE_PARENT_VALUE: "present" },
        spawnImpl: (_execPath, _args, options) => {
          spawnOptions = options;
          return child;
        }
      })
    );

    expect(server.publicationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(spawnOptions.env).toEqual({
      SAFE_PARENT_VALUE: "present",
      GRAPH_PUBLICATION_BUILD_TOKEN: server.publicationToken
    });
    expect(process.env.GRAPH_PUBLICATION_BUILD_TOKEN).toBe(parentToken);
    await server.finish();
  });

  it.each([
    { outcome: "success", failAfterReady: false },
    { outcome: "failure", failAfterReady: true }
  ])("stops its directly spawned Next child after publication $outcome", async ({ failAfterReady }) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-process-"));
    const fixtureServer = createGraphFixtureServer({ failAfterReady });
    await listenOnRandomPort(fixtureServer);
    const address = fixtureServer.address();
    const child = new FakeChildProcess();
    const signalTarget = new EventEmitter();
    const nextCliPath = path.join(rootDir, "next-cli.js");
    let spawnCall;

    const run = main(
      [`--port=${address.port}`, "--now=2026-07-16T05:01:00.000Z"],
      {
        rootDir,
        graphServerOptions: {
          commandTimeoutMs: 1_000,
          forwardSignal: () => undefined,
          nextCliPath,
          signalTarget,
          spawnImpl: (...args) => {
            spawnCall = args;
            return child;
          },
          stopTimeoutMs: 20
        }
      }
    );

    try {
      if (failAfterReady) {
        await expect(run).rejects.toThrow(/graph api failed/i);
      } else {
        await expect(run).resolves.toMatchObject({ status: "updated" });
      }
    } finally {
      await closeServer(fixtureServer);
    }

    expect(spawnCall[0]).toBe(process.execPath);
    expect(spawnCall[1]).toEqual([
      nextCliPath,
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(address.port)
    ]);
    expect(spawnCall[2]).toMatchObject({
      detached: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("rolls back an active publication before forwarding SIGTERM", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-signal-rollback-"));
    const sentinelPath = path.join(rootDir, "public", "graph", "s2026.json");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "sentinel\n", "utf8");
    const fixtureServer = createGraphFixtureServer({ failAfterReady: false });
    await listenOnRandomPort(fixtureServer);
    const address = fixtureServer.address();
    const child = new FakeChildProcess();
    const signalTarget = new EventEmitter();
    const forwardedSignals = [];
    let filesAtForward;
    let sentinelAtForward;
    let signalInjected = false;

    const run = main(
      [`--port=${address.port}`, "--now=2026-07-16T05:01:00.000Z"],
      {
        rootDir,
        graphServerOptions: graphServerTestOptions(child, {
          forwardSignal: (signal) => {
            forwardedSignals.push(signal);
            filesAtForward = listRelativeFiles(rootDir);
            sentinelAtForward = fs.readFileSync(sentinelPath, "utf8");
          },
          signalTarget
        }),
        publicationOptions: {
          renameImpl: async (source, destination) => {
            await fs.promises.rename(source, destination);
            if (!signalInjected && destination === sentinelPath && source.endsWith(".tmp")) {
              signalInjected = true;
              signalTarget.emit("SIGTERM");
            }
          }
        }
      }
    );

    try {
      await expect(run).rejects.toThrow(/received SIGTERM/i);
    } finally {
      await closeServer(fixtureServer);
    }

    expect(signalInjected).toBe(true);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(child.signalCode).toBe("SIGTERM");
    expect(forwardedSignals).toEqual(["SIGTERM"]);
    expect(sentinelAtForward).toBe("sentinel\n");
    expect(filesAtForward).toEqual(["public/graph/s2026.json"]);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("sentinel\n");
    expect(listRelativeFiles(rootDir)).toEqual(["public/graph/s2026.json"]);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("rejects publication when the child exits after the final graph fetch", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-benchmark-final-fetch-exit-"));
    const sentinelPath = path.join(rootDir, "public", "graph", "s2026.json");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "sentinel\n", "utf8");
    const fixtureServer = createGraphFixtureServer({ failAfterReady: false });
    await listenOnRandomPort(fixtureServer);
    const address = fixtureServer.address();
    const child = new FakeChildProcess();
    const signalTarget = new EventEmitter();
    let completedFetches = 0;

    const run = main(
      [`--port=${address.port}`, "--now=2026-07-16T05:01:00.000Z"],
      {
        rootDir,
        fetchGraphImpl: async (...args) => {
          const graph = await fetchGraph(...args);
          completedFetches += 1;
          if (completedFetches === BATCH_SNAPSHOTS.length) {
            child.exitWithCode(17);
          }
          return graph;
        },
        graphServerOptions: graphServerTestOptions(child, { signalTarget })
      }
    );

    try {
      await expect(run).rejects.toThrow(/exited before publication \(17\)/i);
    } finally {
      await closeServer(fixtureServer);
    }

    expect(completedFetches).toBe(BATCH_SNAPSHOTS.length);
    expect(child.exitCode).toBe(17);
    expect(child.killSignals).toEqual([]);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("sentinel\n");
    expect(listRelativeFiles(rootDir)).toEqual(["public/graph/s2026.json"]);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops and force-kills the child when the graph server command times out", async () => {
    const child = new FakeChildProcess({ exitOnSignal: "SIGKILL" });
    const server = getGraphApiServer(
      { port: 3210 },
      graphServerTestOptions(child, {
        commandTimeoutMs: 5,
        stopTimeoutMs: 5
      })
    );

    await waitForAbort(server.signal);
    await server.finish();

    expect(server.signal.reason).toMatchObject({
      message: "Graph server command exceeded 5ms."
    });
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("delays termination forwarding until publisher finalization", async () => {
    const child = new FakeChildProcess();
    const signalTarget = new EventEmitter();
    const forwardedSignals = [];
    const server = getGraphApiServer(
      { port: 3211 },
      graphServerTestOptions(child, {
        forwardSignal: (signal) => forwardedSignals.push(signal),
        signalTarget
      })
    );

    signalTarget.emit("SIGTERM");
    await server.stop();

    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(child.signalCode).toBe("SIGTERM");
    expect(forwardedSignals).toEqual([]);
    expect(signalTarget.listenerCount("SIGINT")).toBe(1);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(1);

    await server.finish();

    expect(forwardedSignals).toEqual(["SIGTERM"]);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not spawn or install lifecycle handlers for an external base URL", async () => {
    const signalTarget = new EventEmitter();
    let spawned = false;
    expect(() => getGraphApiServer(
      { baseUrl: "https://graph.example.test/" },
      { signalTarget }
    )).toThrow(/requires GRAPH_PUBLICATION_BUILD_TOKEN or GRAPH_DIAGNOSTICS_SECRET/);

    const server = getGraphApiServer(
      {
        baseUrl: "https://graph.example.test/",
        diagnosticsSecret: "diagnostics-secret",
        publicationToken: "must-not-leave-loopback"
      },
      {
        signalTarget,
        spawnImpl: () => {
          spawned = true;
        }
      }
    );

    expect(server.baseUrl).toBe("https://graph.example.test");
    expect(server.publicationToken).toBeUndefined();
    expect(server.diagnosticsSecret).toBe("diagnostics-secret");
    expect(server.signal).toBeUndefined();
    await server.finish();
    expect(spawned).toBe(false);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });
});

function graphServerTestOptions(child, overrides = {}) {
  return {
    commandTimeoutMs: 1_000,
    execPath: "/test/node",
    forwardSignal: () => undefined,
    nextCliPath: "/test/next",
    signalTarget: new EventEmitter(),
    spawnImpl: () => child,
    stopTimeoutMs: 20,
    ...overrides
  };
}

class FakeChildProcess extends EventEmitter {
  constructor({ exitOnSignal = "SIGTERM" } = {}) {
    super();
    this.exitCode = null;
    this.exitOnSignal = exitOnSignal;
    this.killSignals = [];
    this.pid = 42_001;
    this.signalCode = null;
    this.stderr = new PassThrough();
    this.stdout = new PassThrough();
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (signal === this.exitOnSignal) {
      queueMicrotask(() => {
        if (this.exitCode !== null || this.signalCode !== null) {
          return;
        }
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }

  exitWithCode(code) {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function createGraphFixtureServer({ failAfterReady }) {
  let graphRequestCount = 0;
  const generatedAt = new Date("2026-07-16T05:01:00.000Z");
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.searchParams.get("batch") === "__benchmark_readiness__") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"invalid readiness batch"}\n');
      return;
    }

    graphRequestCount += 1;
    if (failAfterReady && graphRequestCount >= 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"fixture failure"}\n');
      return;
    }

    const slug = requestUrl.searchParams.get("batch");
    const topVoices = requestUrl.searchParams.get("topVoices") ?? undefined;
    const descriptor = BATCH_SNAPSHOTS.find(
      (candidate) => candidate.slug === slug && candidate.topVoices === topVoices
    );
    if (!descriptor) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"unknown fixture"}\n');
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(graphFor(descriptor, generatedAt))}\n`);
  });
}

function listenOnRandomPort(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function listRelativeFiles(rootDir) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, entryPath).split(path.sep).join("/"));
      }
    }
  };
  visit(rootDir);
  return files.sort();
}

function waitForAbort(signal) {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

function graphSnapshots(generatedAt) {
  return BATCH_SNAPSHOTS.map((descriptor) => ({
    descriptor: { ...descriptor },
    graph: graphFor(descriptor, generatedAt)
  }));
}

function writeSkipHistories(rootDir, { recordedAt, staleBatch, staleInputBatch }) {
  const historyDir = path.join(rootDir, "outputs", "benchmarks");
  fs.mkdirSync(historyDir, { recursive: true });

  for (const descriptor of BATCH_SNAPSHOTS.filter((candidate) => !candidate.topVoices)) {
    const snapshotRecordedAt = descriptor.slug === staleBatch
      ? new Date(recordedAt.getTime() - 24 * 60 * 60 * 1_000)
      : recordedAt;
    const snapshotInputGeneratedAt = descriptor.slug === staleInputBatch
      ? new Date(recordedAt.getTime() - 24 * 60 * 60 * 1_000)
      : snapshotRecordedAt;
    const snapshot = {
      recordedAt: snapshotRecordedAt.toISOString(),
      scoringModelVersion: "4.3.0",
      inputGeneratedAt: snapshotInputGeneratedAt.toISOString(),
      companies: []
    };
    fs.writeFileSync(
      path.join(historyDir, `${descriptor.slug.toLowerCase()}-score-benchmarks.json`),
      `${JSON.stringify({
        version: 1,
        batchSlug: descriptor.slug,
        updatedAt: snapshot.recordedAt,
        daily: [snapshot],
        weekly: []
      })}\n`,
      "utf8"
    );
  }
}

function graphFor(descriptor, generatedAt) {
  const topVoices = descriptor.topVoices ?? "off";
  const rows = topVoices === "off"
    ? [
        leaderboardRow("company-1", "Company 1", 86, 1, 90),
        leaderboardRow("company-2", "Company 2", 78, 2, 81)
      ]
    : [leaderboardRow("company-1", "Company 1", 86, 1, 90)];
  const evidence = rows.map((row) => benchmarkEvidence(row, generatedAt, topVoices));
  return {
    batch: {
      slug: descriptor.slug,
      label: descriptor.slug,
      companyCountExpected: 2,
      companyCountObserved: 2
    },
    batches: [],
    nodes: rows.map((row) => ({
      id: `company:${row.companyId}`,
      entityType: "company",
      entityId: row.companyId,
      label: row.companyName,
      batchSlug: descriptor.slug,
      score: row.score,
      platformScores: { x: row.platformScore },
      topPlatform: "x",
      evidenceIds: [benchmarkEvidenceId(row)],
      scoreBreakdown: v4ScoreBreakdown(row.score, row.platformScore),
      ...(topVoices === "off" ? {} : { selectedTopVoiceAudience: { id: topVoices } })
    })),
    edges: [],
    leaderboard: rows,
    fastestGaining: rows.map((row) => ({
      rank: row.rank,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: momentum(row),
      wow: momentum(row)
    })),
    needsReview: [],
    evidence,
    platformStatus: [],
    selectedTopVoiceAudience: { id: topVoices },
    topVoiceAudiences: [],
    generatedAt: generatedAt.toISOString(),
    scoringContext: {
      modelId: "returner-traction",
      modelVersion: "4.3.0",
      modelName: "returner-traction-v4-bounded-primary-signal-global-best",
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: generatedAt.toISOString(),
      evidenceAsOf: null
    },
    mode: "official_snapshot"
  };
}

function v4ScoreBreakdown(score, platformScore) {
  return {
    modelId: "returner-traction",
    modelVersion: "4.3.0",
    modelName: "returner-traction-v4-bounded-primary-signal-global-best",
    totalScore: score,
    absoluteScore: score,
    weightedAvailableScore: platformScore,
    coverageFactor: 0.21,
    platformsWithEvidence: 1,
    totalSupportedPlatforms: 9,
    platformScores: { x: platformScore },
    weightedPlatforms: [{
      platform: "x",
      score: platformScore,
      configuredWeight: 0.21,
      appliedWeight: 0.9605,
      contribution: Math.round(platformScore * 0.9605 * 100) / 100,
      evidenceCount: 1
    }],
    signalFamilyScores: {
      reach: score,
      engagement: score,
      developerAdoption: 0,
      launchAndCommunity: 0,
      momentum: 0
    },
    confidence: {
      level: "medium",
      value: 0.5,
      reasons: ["Updater fixture has one verified row."],
      scoredEvidenceCount: 1,
      datedEvidenceCount: 1,
      verifiedLinkCount: 1
    },
    calibration: {
      method: "global_best_ratio",
      cohortSize: 6,
      percentile: null,
      inputScore: score,
      benchmarkScore: 100,
      scaleFactor: 1,
      benchmarkScope: "all_supported_batches",
      benchmarkPopulation: "current_company_snapshot"
    },
    limitations: [],
    evidenceAsOf: null,
    explanation: "Updater v4 contract fixture."
  };
}

function leaderboardRow(companyId, companyName, score, rank, platformScore) {
  return {
    rank,
    companyId,
    companyName,
    score,
    platformScore,
    topPlatform: "x",
    socialAccounts: [],
    biggestContribution: null
  };
}

function benchmarkEvidenceId(row) {
  return `evidence-${row.companyId}`;
}

function benchmarkEvidence(row, generatedAt, topVoices) {
  return {
    id: benchmarkEvidenceId(row),
    entityType: "company",
    entityId: row.companyId,
    platform: "x",
    postedAt: generatedAt.toISOString(),
    publishedAtPrecision: "exact",
    metrics: { views: 1_000 },
    contributionScore: row.platformScore,
    normalizedScore: row.platformScore,
    sourceUrl: `https://x.com/${row.companyId}/status/${row.rank}`,
    review_state: "verified",
    linkStatus: "verified",
    ...(topVoices === "off"
      ? {}
      : {
          topVoice: {
            audienceId: topVoices,
            originalContributionScore: row.platformScore
          }
        })
  };
}

function momentum(row) {
  return {
    scoreDelta: 0,
    percentDelta: 0,
    rankDelta: 0,
    currentScore: row.score,
    currentRank: row.rank,
    baselineScore: null,
    baselineRank: null,
    benchmarkedAt: null
  };
}
