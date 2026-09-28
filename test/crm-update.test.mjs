import assert from "node:assert/strict";
import { test } from "node:test";

import { CrmUpdateError, parseUpdateArguments, runCrmUpdate } from "../scripts/lib/crm-update.mjs";

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
    readRevision: async () => revision,
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

test("the same version is a no-op that touches nothing", async () => {
  const harness = createHarness({ revision: TARGET });
  const result = await harness.run();

  assert.equal(result.status, "unchanged");
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.events, []);
  assert.match(harness.logs.join("\n"), /ya está en la versión/u);
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
