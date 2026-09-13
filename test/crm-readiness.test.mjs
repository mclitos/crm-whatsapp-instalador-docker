import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import { inspectCurrentWorkspaceReadiness } from "../scripts/lib/crm-readiness.mjs";
import { CrmWorkspace } from "../scripts/lib/crm-workspace.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

const createFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "crm-readiness-test-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(directory, "package-lock.json"), '{"name":"fixture","lockfileVersion":3}\n');
  await writeFile(join(directory, ".env.local"), "PRIVATE_TOKEN=must-never-appear\nNEXT_PUBLIC_SITE_URL=http://localhost:3300\n");
  await writeFile(join(directory, "src", "app.mjs"), "export const value = 1;\n");
  await execFileAsync("git", ["init", "--quiet", directory]);
  await execFileAsync("git", ["-C", directory, "add", "package.json", "package-lock.json", "src/app.mjs"]);
  await execFileAsync("git", [
    "-C", directory,
    "-c", "commit.gpgsign=false",
    "-c", "user.name=Readiness Test",
    "-c", "user.email=readiness@example.invalid",
    "commit", "--quiet", "-m", "test: create fixture",
  ]);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

test("strict readiness classifies missing, current, and stale workspaces", async () => {
  const directory = await createFixture();
  assert.deepEqual(await inspectCurrentWorkspaceReadiness(directory), { status: "missing" });

  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  const current = await inspectCurrentWorkspaceReadiness(directory);
  assert.equal(current.status, "ready");
  assert.match(current.marker.fingerprint, /^[a-f0-9]{64}$/u);

  await writeFile(join(directory, "src", "app.mjs"), "export const value = 2;\n");
  assert.deepEqual(await inspectCurrentWorkspaceReadiness(directory), { status: "stale" });
});

test("strict readiness returns secret-free invalid and stale classifications", async () => {
  const directory = await createFixture();
  const secret = "marker-secret-that-must-not-escape";
  await writeFile(join(directory, ".installer-ready.json"), `{${secret}}\n`);
  assert.deepEqual(await inspectCurrentWorkspaceReadiness(directory), { status: "invalid" });

  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  await writeFile(join(directory, ".env.local"), `${secret}=changed\nNEXT_PUBLIC_SITE_URL=http://localhost:4400\n`);
  const result = await inspectCurrentWorkspaceReadiness(directory);
  assert.deepEqual(result, { status: "stale" });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
