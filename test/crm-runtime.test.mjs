import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

const loadModules = async () => {
  try {
    return {
      ...(await import("../scripts/container/crm-runtime.mjs")),
      ...(await import("../scripts/lib/crm-workspace.mjs")),
    };
  } catch {
    return {};
  }
};

const createFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "crm-runtime-test-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, "public"), { recursive: true });
  await writeFile(join(directory, "package.json"), '{"name":"fixture","scripts":{"build":"fixture","start":"fixture"}}\n');
  await writeFile(join(directory, "package-lock.json"), '{"name":"fixture","lockfileVersion":3,"packages":{}}\n');
  await writeFile(join(directory, ".env.local"), "TOKEN=never-log-this-secret\nNEXT_PUBLIC_VALUE=placeholder\n");
  await writeFile(join(directory, ".gitignore"), "ignored-source.mjs\n");
  await writeFile(join(directory, "src", "app.mjs"), "export const value = 'original';\n");
  await writeFile(join(directory, "public", "logo.txt"), "public asset\n");
  await execFileAsync("git", ["init", "--quiet", directory]);
  await execFileAsync("git", [
    "-C", directory,
    "add", ".gitignore", "package.json", "package-lock.json", "public/logo.txt", "src/app.mjs",
  ]);
  await execFileAsync("git", [
    "-C", directory,
    "-c", "commit.gpgsign=false",
    "-c", "user.name=CRM Runtime Test",
    "-c", "user.email=crm-runtime@example.invalid",
    "commit", "--quiet", "-m", "test: create fixture",
  ]);
  return directory;
};

const createStandaloneBuildOutput = async (
  directory,
  { includeServer = true, includeStatic = true } = {},
) => {
  await mkdir(join(directory, ".next", "standalone"), { recursive: true });
  if (includeServer) {
    await writeFile(join(directory, ".next", "standalone", "server.js"), "// standalone server\n");
  }
  if (includeStatic) {
    await mkdir(join(directory, ".next", "static", "chunks"), { recursive: true });
    await writeFile(join(directory, ".next", "static", "chunks", "app.js"), "static asset\n");
  }
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("runtime waits only for a genuinely unready workspace", async () => {
  const { CrmWorkspace, waitForReadyWorkspace } = await loadModules();
  assert.equal(typeof waitForReadyWorkspace, "function");
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  let sleeps = 0;

  const ready = await waitForReadyWorkspace({
    directory,
    maxAttempts: 3,
    pollIntervalMs: 1,
    async sleep() {
      sleeps += 1;
      if (sleeps === 1) await workspace.markReady();
    },
    logger: { info() {}, error() {} },
  });

  assert.equal(sleeps, 1);
  assert.match(ready.fingerprint, /^[a-f0-9]{64}$/u);
});

test("runtime rejects an invalid ready workspace instead of polling forever", async () => {
  const { waitForReadyWorkspace } = await loadModules();
  assert.equal(typeof waitForReadyWorkspace, "function");
  const directory = await createFixture();
  await writeFile(join(directory, ".installer-ready.json"), '{"version":1,"fingerprint":"invalid"}\n');
  let sleeps = 0;

  await assert.rejects(waitForReadyWorkspace({
    directory,
    maxAttempts: 3,
    sleep: async () => { sleeps += 1; },
    logger: { info() {}, error() {} },
  }), /inválid|incomplet|readiness/u);
  assert.equal(sleeps, 0);
});

test("runtime builds, prepares standalone assets, starts the generated server, and reuses the build", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  assert.equal(typeof runCrmRuntime, "function");
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady({ now: new Date("2026-08-31T12:00:00.000Z") });
  const calls = [];
  const logs = [];
  const dependencies = {
    directory,
    maxAttempts: 1,
    logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    async runCommand(command, args) {
      calls.push([command, ...args].join(" "));
      if (args[0] === "ci") await mkdir(join(directory, "node_modules"));
      if (args[0] === "run") await createStandaloneBuildOutput(directory);
    },
    async startCommand(command, args, options) {
      calls.push([command, ...args].join(" "));
      assert.equal(command, "node");
      assert.deepEqual(args, [".next/standalone/server.js"]);
      assert.equal(options.cwd, directory);
      assert.equal(options.env.PORT, "3000");
      assert.equal(options.env.HOSTNAME, "0.0.0.0");
      return { code: 0, signal: null };
    },
  };

  await runCrmRuntime(dependencies);
  assert.deepEqual(calls, ["npm ci --include=dev", "npm run build", "node .next/standalone/server.js"]);
  assert.equal(
    await readFile(join(directory, ".next", "standalone", "public", "logo.txt"), "utf8"),
    "public asset\n",
  );
  assert.equal(
    await readFile(join(directory, ".next", "standalone", ".next", "static", "chunks", "app.js"), "utf8"),
    "static asset\n",
  );
  const markerPath = join(directory, ".installer-build.json");
  const firstMarker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.match(firstMarker.fingerprint, /^[a-f0-9]{64}$/u);
  if (process.platform !== "win32") assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
  assert.equal(logs.join("\n").includes("never-log-this-secret"), false);

  calls.length = 0;
  await rm(join(directory, ".next", "standalone", "public"), { recursive: true, force: true });
  await writeFile(
    join(directory, ".next", "standalone", ".next", "static", "chunks", "app.js"),
    "stale replacement target\n",
  );
  await writeFile(
    join(directory, ".next", "standalone", ".next", "static", "stale.js"),
    "stale static asset\n",
  );
  await runCrmRuntime(dependencies);
  assert.deepEqual(calls, ["node .next/standalone/server.js"]);
  assert.equal(
    await readFile(join(directory, ".next", "standalone", "public", "logo.txt"), "utf8"),
    "public asset\n",
  );
  assert.equal(
    await readFile(join(directory, ".next", "standalone", ".next", "static", "chunks", "app.js"), "utf8"),
    "static asset\n",
  );
  await assert.rejects(
    stat(join(directory, ".next", "standalone", ".next", "static", "stale.js")),
    { code: "ENOENT" },
  );
});

test("runtime fails after a successful build when the standalone server is missing", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  const calls = [];

  await assert.rejects(runCrmRuntime({
    directory,
    maxAttempts: 1,
    logger: { info() {}, error() {} },
    async runCommand(command, args) {
      calls.push([command, ...args].join(" "));
      if (args[0] === "ci") await mkdir(join(directory, "node_modules"));
      if (args[0] === "run") await createStandaloneBuildOutput(directory, { includeServer: false });
    },
    async startCommand() {
      calls.push("unexpected start");
      return { code: 0, signal: null };
    },
  }), /standalone\/server\.js.*output.*standalone/iu);

  assert.deepEqual(calls, ["npm ci --include=dev", "npm run build"]);
  await assert.rejects(stat(join(directory, ".installer-build.json")), { code: "ENOENT" });
});

test("runtime rejects missing or non-directory required static assets before publication and start", async (context) => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();

  for (const staticSource of ["missing", "file"]) {
    await context.test(staticSource, async () => {
      const directory = await createFixture();
      const workspace = new CrmWorkspace({ directory });
      await workspace.markReady();
      const calls = [];

      await assert.rejects(runCrmRuntime({
        directory,
        maxAttempts: 1,
        logger: { info() {}, error() {} },
        async runCommand(command, args) {
          calls.push([command, ...args].join(" "));
          if (args[0] === "ci") await mkdir(join(directory, "node_modules"));
          if (args[0] === "run") {
            await createStandaloneBuildOutput(directory, { includeStatic: false });
            if (staticSource === "file") {
              await writeFile(join(directory, ".next", "static"), "not a directory\n");
            }
          }
        },
        async startCommand() {
          calls.push("unexpected start");
          return { code: 0, signal: null };
        },
      }), /\.next\/static.*requerid.*directorio/iu);

      assert.deepEqual(calls, ["npm ci --include=dev", "npm run build"]);
      await assert.rejects(stat(join(directory, ".installer-build.json")), { code: "ENOENT" });
    });
  }
});

test("cached runtime rebuilds when required static output is missing or file-valued", async (context) => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();

  for (const staticSource of ["missing", "file"]) {
    await context.test(staticSource, async () => {
      const directory = await createFixture();
      const workspace = new CrmWorkspace({ directory });
      await workspace.markReady();
      const calls = [];
      const dependencies = {
        directory,
        maxAttempts: 1,
        logger: { info() {}, error() {} },
        async runCommand(_command, args) {
          calls.push(args.join(" "));
          if (args[0] === "ci") await mkdir(join(directory, "node_modules"), { recursive: true });
          else {
            await rm(join(directory, ".next", "static"), { recursive: true, force: true });
            await createStandaloneBuildOutput(directory);
          }
        },
        async startCommand() { calls.push("start"); return { code: 0, signal: null }; },
      };
      await runCrmRuntime(dependencies);

      await rm(join(directory, ".next", "static"), { recursive: true, force: true });
      if (staticSource === "file") {
        await writeFile(join(directory, ".next", "static"), "not a directory\n");
      }
      calls.length = 0;

      await runCrmRuntime(dependencies);

      assert.deepEqual(calls, ["ci --include=dev", "run build", "start"]);
      assert.equal((await stat(join(directory, ".next", "static"))).isDirectory(), true);
    });
  }
});

test("runtime treats public as optional and removes stale standalone public assets", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  const directory = await createFixture();
  await rm(join(directory, "public"), { recursive: true, force: true });
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  let started = false;

  await runCrmRuntime({
    directory,
    maxAttempts: 1,
    logger: { info() {}, error() {} },
    async runCommand(_command, args) {
      if (args[0] === "ci") {
        await mkdir(join(directory, "node_modules"));
        return;
      }
      await createStandaloneBuildOutput(directory);
      await mkdir(join(directory, ".next", "standalone", "public"), { recursive: true });
      await writeFile(join(directory, ".next", "standalone", "public", "stale.txt"), "stale\n");
    },
    async startCommand() {
      started = true;
      return { code: 0, signal: null };
    },
  });

  assert.equal(started, true);
  await assert.rejects(stat(join(directory, ".next", "standalone", "public")), { code: "ENOENT" });
  assert.equal(
    await readFile(join(directory, ".next", "standalone", ".next", "static", "chunks", "app.js"), "utf8"),
    "static asset\n",
  );
});

test("runtime rebuilds when tracked source content changes without changing HEAD", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  const calls = [];
  const dependencies = {
    directory,
    maxAttempts: 1,
    logger: { info() {}, error() {} },
    async runCommand(_command, args) {
      calls.push(args.join(" "));
      if (args[0] === "ci") await mkdir(join(directory, "node_modules"), { recursive: true });
      else await createStandaloneBuildOutput(directory);
    },
    async startCommand() { calls.push("start"); return { code: 0, signal: null }; },
  };
  await runCrmRuntime(dependencies);
  const { stdout: headBefore } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"]);

  calls.length = 0;
  await writeFile(join(directory, "src", "app.mjs"), "export const value = 'modified';\n");
  await runCrmRuntime(dependencies);
  const { stdout: headAfter } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"]);

  assert.equal(headAfter, headBefore);
  assert.deepEqual(calls, ["ci --include=dev", "run build", "start"]);
});

test("runtime includes relevant untracked files but excludes secrets and generated state", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  const calls = [];
  const logs = [];
  const dependencies = {
    directory,
    maxAttempts: 1,
    logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    async runCommand(_command, args) {
      calls.push(args.join(" "));
      if (args[0] === "ci") await mkdir(join(directory, "node_modules"), { recursive: true });
      else await createStandaloneBuildOutput(directory);
    },
    async startCommand() { calls.push("start"); return { code: 0, signal: null }; },
  };
  await runCrmRuntime(dependencies);

  calls.length = 0;
  await writeFile(join(directory, "src", "untracked.mjs"), "export const added = true;\n");
  await runCrmRuntime(dependencies);
  assert.deepEqual(calls, ["ci --include=dev", "run build", "start"]);

  calls.length = 0;
  const secret = "excluded-secret-must-not-log";
  await mkdir(join(directory, "dist"), { recursive: true });
  await mkdir(join(directory, "coverage"), { recursive: true });
  await writeFile(join(directory, "ignored-source.mjs"), "ignored change\n");
  await writeFile(join(directory, "node_modules", "generated.txt"), "generated dependency state\n");
  await writeFile(join(directory, ".next", "generated.txt"), "generated build state\n");
  await writeFile(join(directory, "dist", "output.js"), "generated output\n");
  await writeFile(join(directory, "coverage", "coverage.json"), "{}\n");
  await writeFile(join(directory, ".env.local"), `TOKEN=${secret}\nNEXT_PUBLIC_VALUE=placeholder\n`);
  await writeFile(join(directory, ".env.production"), `TOKEN=${secret}\n`);
  await writeFile(join(directory, ".installer-ready.json.tmp-test"), `${secret}\n`);
  await writeFile(join(directory, ".installer-build.json.tmp-test"), `${secret}\n`);
  await writeFile(join(directory, "runtime.log"), `${secret}\n`);
  const readyMarkerPath = join(directory, ".installer-ready.json");
  const readyMarker = JSON.parse(await readFile(readyMarkerPath, "utf8"));
  await writeFile(readyMarkerPath, `${JSON.stringify({ ...readyMarker, readyAt: "2026-09-02T12:00:00.000Z" })}\n`);
  const buildMarkerPath = join(directory, ".installer-build.json");
  const buildMarker = JSON.parse(await readFile(buildMarkerPath, "utf8"));
  await writeFile(buildMarkerPath, `${JSON.stringify({ ...buildMarker, builtAt: "2026-09-02T12:00:00.000Z" })}\n`);
  await runCrmRuntime(dependencies);

  assert.deepEqual(calls, ["start"]);
  assert.equal(logs.join("\n").includes(secret), false);
});

test("runtime fails safely when the Git source inventory cannot be established", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  await rm(join(directory, ".git"), { recursive: true, force: true });
  const logs = [];

  await assert.rejects(runCrmRuntime({
    directory,
    maxAttempts: 1,
    logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    async runCommand() { throw new Error("must not build without a source inventory"); },
    async startCommand() { throw new Error("must not start without a source inventory"); },
  }), /inventario seguro.*checkout de Git.*volumen/u);
  assert.equal(logs.join("\n").includes("never-log-this-secret"), false);
});

test("runtime rebuilds instead of trusting a build marker with unexpected fields", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  const calls = [];
  const dependencies = {
    directory,
    maxAttempts: 1,
    logger: { info() {}, error() {} },
    async runCommand(_command, args) {
      calls.push(args.join(" "));
      if (args[0] === "ci") await mkdir(join(directory, "node_modules"), { recursive: true });
      else await createStandaloneBuildOutput(directory);
    },
    async startCommand() { calls.push("start"); return { code: 0, signal: null }; },
  };

  await runCrmRuntime(dependencies);
  const markerPath = join(directory, ".installer-build.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, `${JSON.stringify({ ...marker, token: "must-not-be-trusted" })}\n`);

  calls.length = 0;
  await runCrmRuntime(dependencies);
  assert.deepEqual(calls, ["ci --include=dev", "run build", "start"]);
});

test("runtime ignores secret-only changes and rebuilds after public environment or source changes", async () => {
  const { CrmWorkspace, runCrmRuntime } = await loadModules();
  const directory = await createFixture();
  const workspace = new CrmWorkspace({ directory });
  await workspace.markReady();
  const calls = [];
  const logs = [];
  const dependencies = {
    directory,
    maxAttempts: 1,
    logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    async runCommand(_command, args) {
      calls.push(args.join(" "));
      if (args[0] === "ci") await mkdir(join(directory, "node_modules"), { recursive: true });
      else await createStandaloneBuildOutput(directory);
    },
    async startCommand() { calls.push("start"); return { code: 0, signal: null }; },
  };
  await runCrmRuntime(dependencies);

  calls.length = 0;
  await writeFile(join(directory, ".env.local"), "TOKEN=changed-secret-must-not-log\nNEXT_PUBLIC_VALUE=placeholder\n");
  await workspace.markReady();
  await runCrmRuntime(dependencies);
  assert.deepEqual(calls, ["start"]);

  calls.length = 0;
  await writeFile(join(directory, ".env.local"), "TOKEN=changed-secret-must-not-log\nNEXT_PUBLIC_VALUE=changed\n");
  await workspace.markReady();
  await runCrmRuntime(dependencies);
  assert.deepEqual(calls, ["ci --include=dev", "run build", "start"]);

  calls.length = 0;
  await execFileAsync("git", [
    "-C", directory,
    "-c", "commit.gpgsign=false",
    "-c", "user.name=CRM Runtime Test",
    "-c", "user.email=crm-runtime@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "test: change revision",
  ]);
  await runCrmRuntime(dependencies);
  assert.deepEqual(calls, ["ci --include=dev", "run build", "start"]);
  assert.equal(logs.join("\n").includes("changed-secret-must-not-log"), false);
});
