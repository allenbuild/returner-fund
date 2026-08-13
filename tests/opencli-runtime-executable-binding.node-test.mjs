import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeModuleUrl = new URL("../scripts/lib/opencli-runtime.mjs", import.meta.url).href;
const runtimeSource = readFileSync(new URL("../scripts/lib/opencli-runtime.mjs", import.meta.url), "utf8");

test("runtime remains bound to the captured canonical binary after the OPENCLI_BIN symlink changes", (t) => {
  const fixture = createExecutableFixture(t);
  const source = `
    import assert from "node:assert/strict";
    import { unlinkSync, symlinkSync } from "node:fs";
    import {
      assertOpenCliRuntimeExecutableIdentity,
      resolveOpenCliRuntime
    } from ${JSON.stringify(runtimeModuleUrl)};
    const runtime = resolveOpenCliRuntime();
    assert.equal(runtime.command, ${JSON.stringify(realpathSync.native(fixture.binaryA))});
    assert.equal(typeof runtime.executableIdentity.device, "bigint");
    assert.equal(typeof runtime.executableIdentity.inode, "bigint");
    unlinkSync(${JSON.stringify(fixture.link)});
    symlinkSync(${JSON.stringify(fixture.binaryB)}, ${JSON.stringify(fixture.link)});
    assert.equal(runtime.command, ${JSON.stringify(realpathSync.native(fixture.binaryA))});
    assert.equal(assertOpenCliRuntimeExecutableIdentity(runtime), true);
  `;
  const result = runRuntimeFixture(source, fixture.link);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("runtime rejects canonical inode replacement immediately before spawn", (t) => {
  const fixture = createExecutableFixture(t);
  const source = `
    import assert from "node:assert/strict";
    import { chmodSync, renameSync, writeFileSync } from "node:fs";
    import {
      assertOpenCliRuntimeExecutableIdentity,
      resolveOpenCliRuntime
    } from ${JSON.stringify(runtimeModuleUrl)};
    const runtime = resolveOpenCliRuntime();
    renameSync(${JSON.stringify(fixture.binaryA)}, ${JSON.stringify(`${fixture.binaryA}.original`)});
    writeFileSync(${JSON.stringify(fixture.binaryA)}, "#!/bin/sh\\nprintf replacement\\n");
    chmodSync(${JSON.stringify(fixture.binaryA)}, 0o755);
    let failure = null;
    try {
      assertOpenCliRuntimeExecutableIdentity(runtime);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "OPENCLI_EXECUTABLE_IDENTITY_CHANGED");
  `;
  const result = runRuntimeFixture(source, fixture.link);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the identity revalidation is directly adjacent to the OpenCLI spawn", () => {
  assert.match(
    runtimeSource,
    /assertOpenCliExecutableIdentity\(command, executableIdentity\);\n\s*const child = spawn\(command, args, \{/
  );
});

function createExecutableFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "returner-opencli-runtime-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binaryA = path.join(root, "opencli-a");
  const binaryB = path.join(root, "opencli-b");
  const link = path.join(root, "configured-opencli");
  writeFileSync(binaryA, "#!/bin/sh\nprintf 'binary-a\\n'\n");
  writeFileSync(binaryB, "#!/bin/sh\nprintf 'binary-b\\n'\n");
  chmodSync(binaryA, 0o755);
  chmodSync(binaryB, 0o755);
  symlinkSync(binaryA, link);
  return { root, binaryA, binaryB, link };
}

function runRuntimeFixture(source, openCliBin) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      OPENCLI_BIN: openCliBin,
      OPENCLI_PROFILE: ""
    }
  });
}
