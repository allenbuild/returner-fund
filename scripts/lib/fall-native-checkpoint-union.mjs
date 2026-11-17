import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const sha = (value) => createHash("sha256").update(value).digest("hex");

export function unionFallNativeCheckpointDocuments(inputs) {
  if (!inputs.length) throw new Error("At least one explicit native checkpoint is required.");
  const byPath = new Map(inputs.map((input) => [resolve(input.path), input]));
  for (const input of inputs) {
    if (input.document.source?.batchSlug !== "F26") throw new Error("Native checkpoint union requires explicit F26 sources.");
    const source = input.document.source;
    if (!source.parentFile && !source.parentSha256) continue;
    const parent = byPath.get(resolve(dirname(input.path), source.parentFile ?? ""));
    if (!parent || parent === input || parent.sha256 !== source.parentSha256 || !/^[a-f0-9]{64}$/.test(source.parentSha256 ?? "")) throw new Error(`Native delta parent is absent or its physical SHA changed: ${input.path}`);
  }
  for (const input of inputs) {
    const visited = new Set();
    let current = input;
    while (current.document.source.parentFile) {
      if (visited.has(current.path)) throw new Error("Native delta parent lineage contains a cycle.");
      visited.add(current.path);
      current = byPath.get(resolve(dirname(current.path), current.document.source.parentFile));
    }
  }
  return {
    source: { batchSlug: "F26", kind: "explicit_native_checkpoint_union_v1", inputs: inputs.map((input) => ({ path: input.path, sha256: input.sha256, source: input.document.source })), fullHistoryComplete: false },
    profiles: inputs.flatMap((input) => input.document.profiles ?? []),
    nativePosts: inputs.flatMap((input) => input.document.nativePosts ?? []).sort((left, right) => (Date.parse(right.observedAt) || 0) - (Date.parse(left.observedAt) || 0))
  };
}

export async function freezeFallNativeCheckpointUnion(paths, outputPath) {
  const inputs = await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(path);
    return { path, bytes, sha256: sha(bytes), document: JSON.parse(bytes) };
  }));
  const document = unionFallNativeCheckpointDocuments(inputs);
  const frozenSources = [];
  for (const [index, input] of inputs.entries()) {
    const path = resolve(dirname(outputPath), `${basename(outputPath, ".json")}-source-${index}.json`);
    await writeFile(path, input.bytes);
    frozenSources.push({ originalPath: input.path, path, sha256: input.sha256 });
  }
  document.source.frozenSources = frozenSources;
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}
