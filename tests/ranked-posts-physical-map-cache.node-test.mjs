import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRankedPostsPhysicalMapCache } from "../scripts/lib/ranked-posts-physical-map-cache.mjs";

const key = (row) => row.physicalKey;
const eligible = (rows) => rows.filter((r) => r.score > 0 && r.verified);
const digest = (keys) => createHash("sha256").update(keys.join("\n")).digest("hex");
const row = (id, score = 3) => ({ id, physicalKey: `x:${id}`, score, verified: true });
const output = (map) => ({ keys: [...map.keys()], ids: [...map.values()].map((r) => r.id), digest: digest([...map.keys()].sort()) });
function currentPhysicalMap(evidence) { return new Map(eligible(evidence).map((r) => [key(r), r])); }

test("reuses exact-array physical maps and sorted keys with identical order, bodies and digest", () => {
  let calls = 0;
  const cache = createRankedPostsPhysicalMapCache({ rankableEvidence: (rows) => { calls++; return eligible(rows); }, canonicalPostKey: key });
  const input = [row("b"), row("excluded", 0), row("a")];
  const actual = cache.physicalMap({ evidence: input, label: "fixture full graph" });
  assert.deepEqual(output(actual), output(currentPhysicalMap(input)));
  assert.strictEqual(cache.physicalMap({ evidence: input, label: "fixture parity" }), actual);
  assert.deepEqual(cache.sortedKeys({ evidence: input, label: "fixture keys" }), ["x:a", "x:b"]);
  const keys = cache.sortedKeys({ evidence: input, label: "fixture keys again" }); keys.push("caller mutation");
  assert.deepEqual(cache.sortedKeys({ evidence: input, label: "fixture keys protected" }), ["x:a", "x:b"]);
  assert.equal(calls, 1); assert.equal(cache.stats().keySorts, 1);
  assert.equal(input[0].id, "b");
});

test("the existing thirteen passes per cohort compute only six distinct immutable arrays", () => {
  let calls = 0;
  const cache = createRankedPostsPhysicalMapCache({ rankableEvidence: (rows) => { calls++; return eligible(rows); }, canonicalPostKey: key });
  for (const batch of ["S26", "S2026", "A16ZSR006", "F26"]) {
    const full = [0, 1, 2].map((n) => [row(`${batch}-full-${n}`)]);
    const previews = [0, 1, 2].map((n) => [row(`${batch}-preview-${n}`)]);
    cache.physicalMap({ evidence: full[0], label: `${batch} canonical` });
    for (let n = 0; n < 3; n++) {
      const f = cache.physicalMap({ evidence: full[n], label: `${batch} full` });
      const p = cache.physicalMap({ evidence: previews[n], label: `${batch} preview` });
      assert.deepEqual(output(f), output(currentPhysicalMap(full[n])));
      assert.deepEqual(output(p), output(currentPhysicalMap(previews[n])));
      assert.deepEqual(cache.sortedKeys({ evidence: full[n], label: `${batch} full parity` }), [...f.keys()].sort());
      assert.deepEqual(cache.sortedKeys({ evidence: previews[n], label: `${batch} preview parity` }), [...p.keys()].sort());
    }
  }
  assert.equal(calls, 24); assert.equal(cache.stats().computations, 24); assert.equal(cache.stats().reuses, 28);
});

test("function bindings and separate build lifetimes cannot reuse each other's results", () => {
  const input = [row("a")];
  const a = createRankedPostsPhysicalMapCache({ rankableEvidence: eligible, canonicalPostKey: key });
  const b = createRankedPostsPhysicalMapCache({ rankableEvidence: () => [], canonicalPostKey: key });
  const c = createRankedPostsPhysicalMapCache({ rankableEvidence: eligible, canonicalPostKey: (r) => `other:${r.id}` });
  assert.deepEqual([...a.physicalMap({ evidence: input }).keys()], ["x:a"]);
  assert.equal(b.physicalMap({ evidence: input }).size, 0);
  assert.deepEqual([...c.physicalMap({ evidence: input }).keys()], ["other:a"]);
});

test("duplicate and empty-key contract errors remain exact and are never cached as success", () => {
  const cache = createRankedPostsPhysicalMapCache({ rankableEvidence: (r) => r, canonicalPostKey: key });
  const duplicate = [row("a"), row("a")];
  assert.throws(() => cache.physicalMap({ evidence: duplicate, label: "F26/off full graph" }), { message: "Ranked Posts F26/off full graph rankability contract returned duplicate physical key x:a." });
  assert.throws(() => cache.physicalMap({ evidence: [{ physicalKey: "" }], label: "F26/off full graph" }), { message: "Ranked Posts F26/off full graph emitted an empty canonical physical-post key." });
  duplicate.pop(); assert.equal(cache.physicalMap({ evidence: duplicate, label: "fixed" }).size, 1);
  assert.equal(cache.stats().computations, 1);
});

test("mutable inputs require explicit invalidation and changed array identities recompute", () => {
  let calls = 0;
  const cache = createRankedPostsPhysicalMapCache({ rankableEvidence: (r) => { calls++; return eligible(r); }, canonicalPostKey: key });
  const input = [row("a")]; cache.physicalMap({ evidence: input });
  input[0].score = 0;
  assert.equal(cache.invalidate(input), true);
  assert.equal(cache.physicalMap({ evidence: input }).size, 0);
  assert.equal(cache.physicalMap({ evidence: [row("a")] }).size, 1);
  assert.equal(calls, 3); assert.equal(cache.stats().invalidations, 1);
});

test("closed scopes release their cache and reject further reads", () => {
  const cache = createRankedPostsPhysicalMapCache({ rankableEvidence: eligible, canonicalPostKey: key });
  cache.physicalMap({ evidence: [row("a")] }); cache.close();
  assert.equal(cache.stats().closed, true); assert.throws(() => cache.physicalMap({ evidence: [] }), /cache is closed/);
  assert.throws(() => createRankedPostsPhysicalMapCache({ rankableEvidence: eligible }), /explicit rankability/);
});
