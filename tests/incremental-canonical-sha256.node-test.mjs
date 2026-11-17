import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { incrementalCanonicalSha256 } from "../scripts/lib/incremental-canonical-sha256.mjs";

// Independent copy of the experiment runner's pre-existing serializer. Its
// undefined behavior deliberately differs from JSON.stringify on collections.
function legacyCanonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => legacyCanonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((left, right) => String(left).localeCompare(String(right), "en"))
      .map((key) => `${JSON.stringify(key)}:${legacyCanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function legacySha256(value) {
  return createHash("sha256").update(legacyCanonicalJson(value)).digest("hex");
}

function assertParity(value) {
  assert.equal(incrementalCanonicalSha256(value), legacySha256(value));
}

test("preserves nested Unicode, escaping, combining characters and lone surrogates", () => {
  assertParity({
    "é": ["café", "cafe\u0301", "🌍🚀", "汉字", "עברית", "العربية"],
    escaped: { quote: '\"\\\n\r\t\u0000', pair: "\ud83c\udf0d", lone: "\ud800x\udfff" },
    nested: [{ "\ud800": "\udc00", empty: "" }, [], {}]
  });
});

test("uses English locale key ordering rather than default codepoint ordering", () => {
  const value = Object.fromEntries(["Z", "a", "ä", "A", "é", "e", "2", "10"].map((key) => [key, key]));
  const localeKeys = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  assert.notDeepEqual(localeKeys, Object.keys(value).sort());
  assert.equal(legacyCanonicalJson(value), `{${localeKeys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(key)}`).join(",")}}`);
  assertParity(value);
});

test("preserves finite, nonfinite and negative-zero primitive serialization", () => {
  for (const value of [null, true, false, "", 0, -0, 1.25, -42, 1e-200, 1e200, NaN, Infinity, -Infinity]) {
    assertParity(value);
  }
  assertParity({ numbers: [-0, NaN, Infinity, -Infinity], empty: [[], {}] });
});

test("preserves literal undefined object values and empty undefined array slots", () => {
  const fn = () => "ignored";
  const symbol = Symbol("ignored");
  const value = { undefinedValue: undefined, fn, symbol, array: [undefined, fn, symbol, null] };
  assert.equal(legacyCanonicalJson([undefined, fn, symbol, null]), "[,,,null]");
  assert.equal(legacyCanonicalJson({ value: undefined }), '{"value":undefined}');
  assertParity(value);
});

test("preserves sparse arrays, inherited indexed slots and ignores extra array properties", () => {
  const value = new Array(6);
  value[1] = undefined;
  value[3] = { value: "present" };
  value.extra = "not an array element";
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, "4", { value: "inherited", enumerable: true });
  Object.setPrototypeOf(value, prototype);
  assert.equal(legacyCanonicalJson(value), '[,,,{"value":"present"},"inherited",]');
  assertParity(value);
  assertParity(new Array(4));
});

test("includes only enumerable own object keys without invoking toJSON", () => {
  let calls = 0;
  const value = Object.create({ inherited: "excluded" });
  value.visible = { nested: "included" };
  value.toJSON = () => { calls += 1; throw new Error("must not be invoked"); };
  value[Symbol("symbol-key")] = "excluded";
  Object.defineProperty(value, "hidden", { enumerable: false, get() { throw new Error("must not be read"); } });
  assertParity(value);
  assert.equal(calls, 0);
  assertParity([new Date("2026-11-16T00:00:00.000Z"), new Map([["a", 1]]), new Set([1]), Object(7)]);
});

test("matches undefined-like top-level failures instead of inventing a token", () => {
  for (const value of [undefined, () => {}, Symbol("root")]) {
    assert.throws(() => legacySha256(value), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => incrementalCanonicalSha256(value), { code: "ERR_INVALID_ARG_TYPE" });
  }
});

test("preserves BigInt serialization failure at root and in nested collections", () => {
  for (const value of [1n, [1n], { value: 1n }]) {
    assert.throws(() => legacySha256(value), TypeError);
    assert.throws(() => incrementalCanonicalSha256(value), TypeError);
  }
});

test("preserves Unicode at token-batch boundaries and large individual string tokens", () => {
  assertParity({ a: "x".repeat(64 * 1024 - 4) + "🌍", b: ["\ud800", "🌍", "\udfff"] });
  assertParity(Array.from({ length: 9000 }, (_, index) => ({ index, text: `é${index}🌍` })));
});

test("hashes a 256 MiB serialization under a 64 MiB child heap", { timeout: 30000 }, () => {
  const leafBytes = 64 * 1024;
  const repetitions = 4096;
  const prefix = Buffer.from('{"evidence":[');
  const suffix = Buffer.from("]}");
  const leafToken = Buffer.concat([Buffer.from('"'), Buffer.alloc(leafBytes, 0x78), Buffer.from('"')]);
  const serializedBytes = prefix.length + suffix.length + leafToken.length * repetitions + repetitions - 1;
  assert.ok(serializedBytes > 4 * 64 * 1024 * 1024);

  // This oracle encodes the known ASCII token sequence directly, without using
  // either serializer or retaining the complete serialized dataset.
  const oracle = createHash("sha256").update(prefix);
  for (let index = 0; index < repetitions; index += 1) {
    if (index) oracle.update(",");
    oracle.update(leafToken);
  }
  const expected = oracle.update(suffix).digest("hex");
  const helperUrl = new URL("../scripts/lib/incremental-canonical-sha256.mjs", import.meta.url).href;
  const script = `import { incrementalCanonicalSha256 } from ${JSON.stringify(helperUrl)};
const leaf = "x".repeat(${leafBytes});
const value = { evidence: Array(${repetitions}).fill(leaf) };
process.stdout.write(incrementalCanonicalSha256(value));`;
  const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 25000,
    maxBuffer: 4096,
    env: { ...process.env, NODE_OPTIONS: "" }
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^[a-f0-9]{64}$/);
  assert.equal(child.stdout, expected);
});
