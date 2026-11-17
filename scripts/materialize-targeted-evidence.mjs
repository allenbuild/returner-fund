#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeTargetedEvidence } from "./lib/packed-targeted-evidence.mjs";
export { materializeTargetedEvidence };
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await materializeTargetedEvidence()));
}
