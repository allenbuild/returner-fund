import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptReturnerFundRow,
  loadReturnerFundShardRows
} from "../scripts/lib/returner-fund-shard-adapter.mjs";

test("returner fund adapter flattens the three shard lanes without losing native identity", async () => {
  const entries = await loadReturnerFundShardRows();
  assert.equal(entries.length, 172);
  assert.deepEqual(
    Object.keys(Object.groupBy(entries, (entry) => entry.lane)).sort(),
    ["instagram", "open-platforms", "youtube"]
  );
  assert.equal(entries.filter((entry) => entry.lane === "instagram").length, 88);
  assert.equal(entries.filter((entry) => entry.lane === "open-platforms").length, 8);
  assert.equal(entries.filter((entry) => entry.lane === "youtube").length, 76);

  for (const entry of entries) {
    const row = adaptReturnerFundRow(entry);
    assert.ok(row.sourceUrl);
    assert.ok(row.platform);
    assert.ok(row.platformPostId ?? row.nativeId);
    assert.ok(row.metrics && typeof row.metrics === "object");
  }
});

test("YouTube adapter preserves official attribution and published time", async () => {
  const entry = (await loadReturnerFundShardRows()).find((item) => item.lane === "youtube");
  const row = adaptReturnerFundRow(entry);
  assert.equal(row.platform, "youtube");
  assert.equal(row.platformPostId, entry.row.nativeId);
  assert.equal(row.postedAt, entry.row.publishedAt);
  assert.equal(row.review_state, "verified");
  assert.deepEqual(row.attributionSignals, ["verified_channel_id", "official_youtube_atom_feed"]);
});
