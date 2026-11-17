#!/usr/bin/env node
import { packTargetedEvidence } from "./lib/packed-targeted-evidence.mjs";
const expectedSha256 = process.argv.find((argument) => argument.startsWith("--expected-sha="))?.slice("--expected-sha=".length);
console.log(JSON.stringify(await packTargetedEvidence({ expectedSha256 })));
