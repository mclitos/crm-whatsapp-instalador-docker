import assert from "node:assert/strict";
import { test } from "node:test";

import { CrmUpdateError, parseUpdateArguments, resolveUpdateSource, runCrmUpdate } from "../scripts/lib/crm-update.mjs";

const INSTALLED = "a".repeat(40);
const TARGET = "b".repeat(40);

const createHarness = ({
  status = "",
  targetFiles = ["supabase/migrations/001_first.sql", "supabase/migrations/002_second.sql"],
  applied = ["001", "002"],
  installedTime = 100,
  targetTime = 200,
  revision = INSTALLED,
  fetchError = null,
  migrationError = null,
  verifyOk = true,
  markerRevision = revision,
} = {}) => {
  const calls = [];
  const events = [];
  const git = async (args) => {
    calls.push(args);
    const [command] = args;
    if (command === "status") return status;
    if (command === "fetch") {
      if (fetchError) throw fetchError;
      return "";
    }
    if (command === "ls-tree") return `${targetFiles.join("\n")}\n`;
    if (command === "show") return `${args.at(-1) === TARGET ? targetTime : installedTime}\n`;
    if (command === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const admin = {
    async migracionesAplicadas() { return new Set(applied); },
    async sql() { events.push("verify"); return { ok: verifyOk }; },
  };
  const workspace = {
    async readVerifySchema() { return "select true;"; },
    async markReady() { events.push("markReady"); },
  };
  const applyMigrations = async () => {
    events.push("applyMigrations");
    if (migrationError) throw migrationError;
    return { applied: 1, skipped: 1, total: 2 };
  };
  const logs = [];
  const run = (overrides = {}) => runCrmUpdate({
    target: TARGET,
    directory: "/workspace/crm",
    git,
    admin,
    ref: "project-ref",
    workspace,
    repoUrl: "https://github.com/ArnasDon/wacrm.git",
    readRevision: async () => revision,
    readMarkerRevision: async () => markerRevision,
    applyMigrations,
    log: (line) => logs.push(line),
    ...overrides,
  });
  const checkedOut = () => calls.some(([command]) => command === "checkout");
  return { run, calls, events, logs, checkedOut };
};

const rejectsWith = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CrmUpdateError, String(error));
    assert.equal(error.code, code);
    assert.ok(error.action.length > 0);
    return true;
  });
};

test("the same version with nothing pending and a current marker is a no-op that changes nothing", async () => {
  const harness = createHarness({ revision: TARGET });
  const result = await harness.run();

  assert.equal(result.status, "unchanged");
  assert.equal(harness.calls.some(([command]) => ["fetch", "checkout", "status"].includes(command)), false);
  assert.deepEqual(harness.events, []);
  assert.match(harness.logs.join("\n"), /ya está en la versión/u);
});

test("an update interrupted after checkout requires the flag on rerun and does not check out again", async () => {
  const harness = createHarness({ revision: TARGET, applied: ["001"] });

  await assert.rejects(harness.run(), (error) => {
    assert.equal(error.code, "MIGRATIONS_PENDING");
    assert.match(error.message, /se interrumpió/u);
    assert.match(error.message, /002_second\.sql/u);
    return true;
  });
  assert.deepEqual(harness.events, []);
});

test("rerunning an interrupted update with the flag applies the pending migrations, verifies, and marks ready", async () => {
  const harness = createHarness({ revision: TARGET, applied: ["001"] });
  const result = await harness.run({ allowMigrations: true });

  assert.equal(result.status, "updated");
  assert.equal(result.previous, TARGET);
  assert.equal(result.current, TARGET);
  assert.equal(result.migrationsApplied, 1);
  assert.deepEqual(harness.events, ["applyMigrations", "verify", "markReady"]);
  assert.equal(harness.checkedOut(), false);
  assert.equal(harness.calls.some(([command]) => command === "fetch"), false);
});

test("a stale readiness marker at the target revision is refreshed and reported as updated", async () => {
  const harness = createHarness({ revision: TARGET, markerRevision: INSTALLED });
  const result = await harness.run();

  assert.equal(result.status, "updated");
  assert.deepEqual(harness.events, ["verify", "markReady"]);
  assert.equal(harness.checkedOut(), false);
});

test("a schema verification failure after checkout is retried by rerunning", async () => {
  const failing = createHarness({ verifyOk: false });
  await rejectsWith(failing.run(), "SCHEMA_VERIFICATION_FAILED");
  assert.equal(failing.events.includes("markReady"), false);

  const rerun = createHarness({ revision: TARGET, markerRevision: INSTALLED });
  assert.equal((await rerun.run()).status, "updated");
});

test("the target is fetched from the explicit repository, never from origin", async () => {
  const harness = createHarness();
  await harness.run();

  assert.deepEqual(
    harness.calls.find(([command]) => command === "fetch"),
    ["fetch", "--depth", "1", "https://github.com/ArnasDon/wacrm.git", TARGET],
  );
});

test("a CRM_REPO_URL install must name the commit explicitly", () => {
  const custom = { repoUrl: "https://example.com/fork.git", commit: null };
  assert.throws(
    () => resolveUpdateSource({ commit: null, source: custom }),
    (error) => error.code === "CUSTOM_SOURCE" && /--commit <hash/u.test(error.action),
  );
  assert.deepEqual(
    resolveUpdateSource({ commit: TARGET, source: custom }),
    { repoUrl: custom.repoUrl, target: TARGET },
  );
  const pinned = { repoUrl: "https://github.com/ArnasDon/wacrm.git", commit: INSTALLED };
  assert.equal(resolveUpdateSource({ commit: null, source: pinned }).target, INSTALLED);
  assert.equal(resolveUpdateSource({ commit: TARGET, source: pinned }).target, TARGET);
});

test("tracked local changes stop the update before anything is fetched", async () => {
  const harness = createHarness({ status: " M src/app.tsx\n" });

  await rejectsWith(harness.run(), "LOCAL_CHANGES");
  assert.equal(harness.calls.some(([command]) => command === "fetch"), false);
  assert.equal(harness.checkedOut(), false);
});

test("the local change check ignores untracked installer markers", async () => {
  const harness = createHarness();
  await harness.run();

  const statusCall = harness.calls.find(([command]) => command === "status");
  assert.deepEqual(statusCall, ["status", "--porcelain", "--untracked-files=no"]);
});

test("pending migrations without confirmation list them and never check out", async () => {
  const harness = createHarness({ applied: ["001"] });

  await assert.rejects(harness.run(), (error) => {
    assert.equal(error.code, "MIGRATIONS_PENDING");
    assert.match(error.message, /002_second\.sql/u);
    assert.doesNotMatch(error.message, /001_first\.sql/u);
    assert.match(error.action, /backup/u);
    assert.match(error.action, /--aplicar-migraciones/u);
    return true;
  });
  assert.equal(harness.checkedOut(), false);
  assert.deepEqual(harness.events, []);
});

test("confirmed pending migrations are applied after checkout, verified, and marked ready", async () => {
  const harness = createHarness({ applied: ["001"] });
  const result = await harness.run({ allowMigrations: true });

  assert.equal(result.status, "updated");
  assert.equal(result.previous, INSTALLED);
  assert.equal(result.current, TARGET);
  assert.equal(result.migrationsApplied, 1);
  assert.match(result.rollbackCommand, new RegExp(`--commit ${INSTALLED}$`, "u"));
  assert.deepEqual(harness.events, ["applyMigrations", "verify", "markReady"]);
  assert.deepEqual(
    harness.calls.find(([command]) => command === "checkout"),
    ["checkout", "-q", "--detach", TARGET],
  );
});

test("an update without pending migrations does not touch the database history", async () => {
  const harness = createHarness();
  const result = await harness.run();

  assert.equal(result.status, "updated");
  assert.equal(harness.events.includes("applyMigrations"), false);
  assert.deepEqual(harness.events, ["verify", "markReady"]);
});

test("moving to an older commit warns that migrations are not reverted", async () => {
  const harness = createHarness({ targetTime: 50, applied: ["001", "002", "003"] });
  const result = await harness.run();

  assert.equal(result.rollback, true);
  const logs = harness.logs.join("\n");
  assert.match(logs, /NO se revierten/u);
  assert.match(logs, /1 migración\(es\) que esta versión no conoce/u);
});

test("a failed fetch leaves the checkout untouched", async () => {
  const harness = createHarness({ fetchError: new Error("network") });

  await rejectsWith(harness.run(), "FETCH_FAILED");
  assert.equal(harness.checkedOut(), false);
});

test("a failed migration reports the way back and does not mark ready", async () => {
  const harness = createHarness({ applied: ["001"], migrationError: new Error("boom") });

  await assert.rejects(harness.run({ allowMigrations: true }), (error) => {
    assert.equal(error.code, "MIGRATION_FAILED");
    assert.match(error.action, new RegExp(`--commit ${INSTALLED}`, "u"));
    return true;
  });
  assert.equal(harness.events.includes("markReady"), false);
});

test("a failed schema verification is not marked ready", async () => {
  const harness = createHarness({ verifyOk: false });

  await rejectsWith(harness.run(), "SCHEMA_VERIFICATION_FAILED");
  assert.equal(harness.events.includes("markReady"), false);
});

test("short or malformed target hashes are rejected before any git call", async () => {
  const harness = createHarness();

  await rejectsWith(harness.run({ target: "45e80ad" }), "INVALID_TARGET");
  assert.deepEqual(harness.calls, []);
});

test("an unknown installed revision asks to check the installation", async () => {
  const harness = createHarness({ revision: null });

  await rejectsWith(harness.run(), "REVISION_UNKNOWN");
});

test("update arguments accept --commit and --aplicar-migraciones and reject anything else", () => {
  assert.deepEqual(parseUpdateArguments([]), { commit: null, allowMigrations: false });
  assert.deepEqual(
    parseUpdateArguments(["--commit", TARGET, "--aplicar-migraciones"]),
    { commit: TARGET, allowMigrations: true },
  );
  assert.deepEqual(parseUpdateArguments([`--commit=${TARGET}`]).commit, TARGET);
  assert.throws(() => parseUpdateArguments(["--force"]), (error) => error.code === "UNKNOWN_ARGUMENT");
});
