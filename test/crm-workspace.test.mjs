import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

const loadWorkspaceModule = async () => {
  try {
    return await import("../scripts/lib/crm-workspace.mjs");
  } catch {
    return {};
  }
};

const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-workspace-test-"));
  temporaryDirectories.push(root);
  return root;
};

const createValidCheckout = async (directory) => {
  await mkdir(directory, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", directory]);
  await mkdir(join(directory, "supabase", "migrations"), { recursive: true });
  await mkdir(join(directory, "supabase", "ci"), { recursive: true });
  await mkdir(join(directory, "messages"), { recursive: true });
  await writeFile(join(directory, "supabase", "migrations", "002_second.sql"), "select 2;\n");
  await writeFile(join(directory, "supabase", "migrations", "001_first.sql"), "select 1;\n");
  await writeFile(join(directory, "supabase", "ci", "verify-schema.sql"), "select true;\n");
  await writeFile(join(directory, "messages", "es.json"), "{}\n");
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

test("CRM_WORKSPACE_DIR overrides the default local crm directory", async () => {
  const module = await loadWorkspaceModule();
  assert.equal(typeof module.resolveCrmWorkspaceDir, "function");
  assert.equal(
    module.resolveCrmWorkspaceDir({ CRM_WORKSPACE_DIR: "/workspace/from-env" }),
    "/workspace/from-env",
  );
  assert.equal(basename(module.resolveCrmWorkspaceDir({})), "crm");
});

test("readiness is atomic, secret-free, restrictive, and reusable", async () => {
  const { CrmWorkspace } = await loadWorkspaceModule();
  const root = await createRoot();
  const directory = join(root, "crm");
  await createValidCheckout(directory);
  await writeFile(join(directory, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(directory, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(join(directory, ".env.local"), "SUPABASE_SERVICE_ROLE_KEY=top-secret\n");
  const workspace = new CrmWorkspace({ directory });

  const first = await workspace.markReady({ now: new Date("2026-08-31T12:00:00.000Z") });
  const markerPath = join(directory, ".installer-ready.json");
  const contents = await readFile(markerPath, "utf8");
  const marker = JSON.parse(contents);
  assert.equal(first.reused, false);
  assert.deepEqual(Object.keys(marker).sort(), [
    "environmentFingerprint", "fingerprint", "readyAt", "sourceFingerprint", "sourceRevision", "version",
  ]);
  assert.equal(contents.includes("top-secret"), false);
  assert.match(marker.fingerprint, /^[a-f0-9]{64}$/u);
  if (process.platform !== "win32") assert.equal((await stat(markerPath)).mode & 0o777, 0o600);

  const second = await workspace.markReady({ now: new Date("2026-09-01T12:00:00.000Z") });
  assert.equal(second.reused, true);
  assert.equal(JSON.parse(await readFile(markerPath, "utf8")).readyAt, marker.readyAt);

  await workspace.clearReady();
  await assert.rejects(readFile(markerPath, "utf8"), (error) => error.code === "ENOENT");
});

test("a clone is prepared in a sibling directory and atomically renamed", async () => {
  const { CrmWorkspace } = await loadWorkspaceModule();
  assert.equal(typeof CrmWorkspace, "function");
  const root = await createRoot();
  const directory = join(root, "crm");
  const calls = [];
  const workspace = new CrmWorkspace({
    directory,
    async gitRunner(args) {
      calls.push(args);
      const target = args.at(-1);
      assert.equal(target.startsWith(`${directory}.tmp-`), true);
      await createValidCheckout(target);
    },
  });

  const result = await workspace.ensure("https://example.test/fork.git");

  assert.deepEqual(calls[0].slice(0, 3), ["clone", "--depth", "1"]);
  assert.equal(result.cloned, true);
  assert.equal((await stat(join(directory, ".git"))).isDirectory(), true);
  assert.equal((await stat(join(directory, "supabase", "migrations"))).isDirectory(), true);
});

test("a valid checkout is untouched and an incomplete checkout is rejected without deletion", async () => {
  const { CrmWorkspace } = await loadWorkspaceModule();
  assert.equal(typeof CrmWorkspace, "function");
  const root = await createRoot();
  const validDirectory = join(root, "valid-crm");
  await createValidCheckout(validDirectory);
  await writeFile(join(validDirectory, "keep.txt"), "untouched\n");
  let gitCalls = 0;
  const valid = new CrmWorkspace({
    directory: validDirectory,
    gitRunner: async () => { gitCalls += 1; },
  });

  assert.equal((await valid.ensure("https://example.test/fork.git")).cloned, false);
  assert.equal(await readFile(join(validDirectory, "keep.txt"), "utf8"), "untouched\n");
  assert.equal(gitCalls, 0);

  const incompleteDirectory = join(root, "incomplete-crm");
  await mkdir(incompleteDirectory);
  await writeFile(join(incompleteDirectory, "keep.txt"), "do not delete\n");
  const incomplete = new CrmWorkspace({ directory: incompleteDirectory });
  await assert.rejects(incomplete.ensure("https://example.test/fork.git"), /incomplet/u);
  assert.equal(await readFile(join(incompleteDirectory, "keep.txt"), "utf8"), "do not delete\n");
});

test("an interrupted installer clone is recovered without deleting unknown contents", async (context) => {
  const { CrmWorkspace } = await loadWorkspaceModule();

  await context.test("stale installer temporary directory is replaced", async () => {
    const root = await createRoot();
    const directory = join(root, "crm");
    const stale = join(directory, ".clone-tmp-0123456789abcdef");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "partial"), "interrupted\n");
    const workspace = new CrmWorkspace({
      directory,
      async gitRunner(args) { await createValidCheckout(args.at(-1)); },
    });

    assert.equal((await workspace.ensure("https://example.test/fork.git")).cloned, true);
    assert.equal((await stat(join(directory, "supabase", "migrations"))).isDirectory(), true);
    assert.equal((await readdir(directory)).some((entry) => entry.startsWith(".clone-tmp-")), false);
  });

  await context.test("a recorded partial transfer resumes instead of deleting the checkout", async () => {
    const root = await createRoot();
    const directory = join(root, "crm");
    const temporaryName = ".clone-tmp-0123456789abcdef";
    const temporaryDirectory = join(directory, temporaryName);
    await createValidCheckout(temporaryDirectory);
    const entries = await readdir(temporaryDirectory);
    await writeFile(join(directory, ".installer-clone.json"), `${JSON.stringify({
      version: 1,
      temporaryDirectory: temporaryName,
      entries,
    })}\n`);
    await rename(join(temporaryDirectory, "messages"), join(directory, "messages"));
    let gitCalls = 0;
    const workspace = new CrmWorkspace({
      directory,
      gitRunner: async () => { gitCalls += 1; },
    });

    assert.equal((await workspace.ensure("https://example.test/fork.git")).cloned, true);
    assert.equal(gitCalls, 0);
    assert.equal((await stat(join(directory, ".git"))).isDirectory(), true);
    await assert.rejects(stat(join(directory, ".installer-clone.json")), { code: "ENOENT" });
  });

  await context.test("unknown contents are preserved and block automatic cleanup", async () => {
    const root = await createRoot();
    const directory = join(root, "crm");
    const stale = join(directory, ".clone-tmp-0123456789abcdef");
    await mkdir(stale, { recursive: true });
    await writeFile(join(directory, "keep.txt"), "user-owned\n");
    let gitCalls = 0;
    const workspace = new CrmWorkspace({
      directory,
      gitRunner: async () => { gitCalls += 1; },
    });

    await assert.rejects(workspace.ensure("https://example.test/fork.git"), /incomplet/u);
    assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "user-owned\n");
    assert.equal((await stat(stale)).isDirectory(), true);
    assert.equal(gitCalls, 0);
  });
});

test("migrations, schema verification, and locale are discovered from the checkout", async () => {
  const { CrmWorkspace } = await loadWorkspaceModule();
  assert.equal(typeof CrmWorkspace, "function");
  const root = await createRoot();
  const directory = join(root, "crm");
  await createValidCheckout(directory);
  const workspace = new CrmWorkspace({ directory });

  assert.deepEqual(await workspace.readMigrations(), [
    { fileName: "001_first.sql", version: "001", name: "first", sql: "select 1;\n" },
    { fileName: "002_second.sql", version: "002", name: "second", sql: "select 2;\n" },
  ]);
  assert.equal(await workspace.readVerifySchema(), "select true;\n");
  assert.equal(await workspace.detectLocale(), "es");
});

test("the CRM environment merge preserves durable secrets and unknown upstream variables", async () => {
  const { CrmWorkspace } = await loadWorkspaceModule();
  assert.equal(typeof CrmWorkspace, "function");
  const root = await createRoot();
  const directory = join(root, "crm");
  await createValidCheckout(directory);
  const envPath = join(directory, ".env.local");
  await writeFile(envPath, [
    "ENCRYPTION_KEY=keep-encryption-key",
    "AUTOMATION_CRON_SECRET=keep-cron-secret",
    "UPSTREAM_UNKNOWN=keep-me",
    "NEXT_PUBLIC_SUPABASE_URL=https://old.example",
    "NEXT_PUBLIC_SUPABASE_URL=https://stale-duplicate.example",
    "",
  ].join("\n"));
  const workspace = new CrmWorkspace({ directory, randomSecret: () => "must-not-be-used" });

  await workspace.writeEnvironment({
    supabaseUrl: "https://project.supabase.co",
    anonKey: "anon-secret",
    serviceRoleKey: "service-secret",
    publicUrl: "https://crm.example.com",
    locale: "es",
    metaAppId: "",
    metaAppSecret: "",
  });

  const contents = await readFile(envPath, "utf8");
  assert.match(contents, /^ENCRYPTION_KEY=keep-encryption-key$/mu);
  assert.match(contents, /^AUTOMATION_CRON_SECRET=keep-cron-secret$/mu);
  assert.match(contents, /^UPSTREAM_UNKNOWN=keep-me$/mu);
  assert.match(contents, /^NEXT_PUBLIC_SUPABASE_URL=https:\/\/project\.supabase\.co$/mu);
  assert.doesNotMatch(contents, /stale-duplicate/u);
  if (process.platform !== "win32") assert.equal((await stat(envPath)).mode & 0o777, 0o600);
});
