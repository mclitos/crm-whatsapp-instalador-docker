import assert from "node:assert/strict";
import { test } from "node:test";

const loadSetupModule = async () => {
  try {
    return await import("../scripts/lib/supabase-setup.mjs");
  } catch {
    return {};
  }
};

const createWorkspace = (calls, environmentWrites = []) => ({
  async clearReady() { calls.push("workspace:clear-ready"); },
  async ensure() { calls.push("workspace:ensure"); return { cloned: true }; },
  async readMigrations() {
    calls.push("workspace:migrations");
    return [
      { fileName: "001_first.sql", version: "001", name: "first", sql: "select 1" },
      { fileName: "002_second.sql", version: "002", name: "second", sql: "select 2" },
    ];
  },
  async readVerifySchema() { return "verify schema"; },
  async detectLocale() { return "es"; },
  async writeEnvironment(values) { environmentWrites.push(values); calls.push("workspace:env"); },
  async markReady() { calls.push("workspace:mark-ready"); return { reused: false }; },
});

const createAdmin = (calls, overrides = {}) => ({
  async organizaciones() { calls.push("admin:organizations"); return { ok: true, json: [{ slug: "team", name: "Team" }] }; },
  async proyecto(ref) { calls.push(`admin:project:${ref}`); return { ok: true, json: { name: "CRM", status: "ACTIVE_HEALTHY", region: "sa-east-1" } }; },
  async crearProyecto() { calls.push("admin:create"); return { ok: true, json: { ref: "newprojectref0000000" } }; },
  async esperarProyecto(ref) { calls.push(`admin:wait:${ref}`); return { ok: true, estado: "ACTIVE_HEALTHY" }; },
  async llaves() { calls.push("admin:keys"); return { ok: true, url: "https://project.supabase.co", anon: "anon-secret", serviceRole: "service-secret" }; },
  async prepararTablaMigraciones() { calls.push("admin:prepare"); return { ok: true }; },
  async migracionesAplicadas() { calls.push("admin:applied"); return new Set(["001"]); },
  async aplicarMigracion(_ref, migration) { calls.push(`admin:migrate:${migration.version}:${migration.sql}`); return { ok: true }; },
  async sql(_ref, sql) { calls.push(`admin:sql:${sql}`); return { ok: true }; },
  async configurarAuth(_ref, options) { calls.push(`admin:auth:${options.autoconfirmar}`); return { ok: true }; },
  ...overrides,
});

test("account validation happens before cloning or any workspace write", async () => {
  const { provisionSupabase } = await loadSetupModule();
  assert.equal(typeof provisionSupabase, "function");
  const calls = [];
  const admin = createAdmin(calls, {
    async organizaciones() { calls.push("admin:organizations"); return { ok: false, status: 401, error: "Unauthorized" }; },
  });

  await assert.rejects(
    provisionSupabase(
      { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" },
      { admin, workspace: createWorkspace(calls), credentialStore: { update: async () => {} } },
    ),
    /token|cuenta/u,
  );
  assert.deepEqual(calls, ["admin:organizations"]);
});

test("an existing project is validated, waited for, and provisioned idempotently", async () => {
  const { provisionSupabase } = await loadSetupModule();
  assert.equal(typeof provisionSupabase, "function");
  const calls = [];
  const environmentWrites = [];
  const result = await provisionSupabase(
    { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "https://crm.example.com" },
    {
      admin: createAdmin(calls),
      workspace: createWorkspace(calls, environmentWrites),
      credentialStore: { async update(value) { calls.push(`store:${value.supabaseProjectRef}`); } },
      randomSecret: () => "generated-app-secret",
    },
  );

  assert.ok(calls.indexOf("admin:organizations") < calls.indexOf("workspace:ensure"));
  assert.ok(calls.indexOf("workspace:clear-ready") < calls.indexOf("workspace:ensure"));
  assert.ok(calls.includes("admin:wait:abcdefghijklmnopqrst"));
  assert.equal(calls.includes("admin:sql:select 1"), false);
  assert.equal(calls.includes("admin:sql:select 2"), false);
  assert.ok(calls.includes("admin:migrate:002:select 2"));
  assert.ok(calls.includes("admin:auth:false"));
  assert.equal(environmentWrites.length, 1);
  assert.ok(calls.indexOf("workspace:env") < calls.indexOf("workspace:mark-ready"));
  assert.equal(calls.at(-1), "workspace:mark-ready");
  assert.equal(JSON.stringify(result).includes("anon-secret"), false);
  assert.equal(JSON.stringify(result).includes("service-secret"), false);
});

test("readiness is cleared before mutation and persistence failure prevents completion", async () => {
  const { provisionSupabase } = await loadSetupModule();
  const calls = [];
  const events = [];
  const workspace = createWorkspace(calls);
  workspace.markReady = async () => {
    calls.push("workspace:mark-ready");
    throw new Error("ready marker storage failed");
  };

  await assert.rejects(provisionSupabase(
    { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" },
    {
      admin: createAdmin(calls),
      workspace,
      credentialStore: { update: async () => {} },
      onProgress: (event) => events.push(event),
    },
  ), /ready marker storage failed/u);

  assert.ok(calls.indexOf("workspace:clear-ready") < calls.indexOf("workspace:ensure"));
  assert.ok(calls.indexOf("workspace:env") < calls.indexOf("workspace:mark-ready"));
  assert.equal(events.some((event) => event.stage === "completed"), false);
});

test("failure after workspace invalidation leaves readiness absent", async () => {
  const { provisionSupabase } = await loadSetupModule();
  const calls = [];
  let ready = true;
  const workspace = createWorkspace(calls);
  workspace.clearReady = async () => { calls.push("workspace:clear-ready"); ready = false; };
  workspace.markReady = async () => { ready = true; };

  await assert.rejects(provisionSupabase(
    { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" },
    {
      admin: createAdmin(calls, {
        migracionesAplicadas: async () => new Set(),
        async sql() { return { ok: false }; },
      }),
      workspace,
      credentialStore: { update: async () => {} },
    },
  ));

  assert.equal(ready, false);
});

test("project creation persists the password before creation and the ref immediately afterward", async () => {
  const { provisionSupabase } = await loadSetupModule();
  assert.equal(typeof provisionSupabase, "function");
  const calls = [];
  const password = "database-password-secret";
  const admin = createAdmin(calls, {
    async crearProyecto(input) {
      assert.equal(input.dbPass, password);
      calls.push("admin:create");
      return { ok: true, json: { ref: "newprojectref0000000" } };
    },
  });
  const stored = [];

  const result = await provisionSupabase(
    { mode: "create", organizationSlug: "team", name: "CRM", region: "sa-east-1", publicUrl: "http://localhost:3000" },
    {
      admin,
      workspace: createWorkspace(calls),
      credentialStore: { async update(value) { stored.push(value); calls.push(value.supabaseProjectRef ? "store:ref" : "store:password"); } },
      generateDbPassword: () => password,
      randomSecret: () => "generated-app-secret",
    },
  );

  assert.ok(calls.indexOf("store:password") < calls.indexOf("admin:create"));
  assert.ok(calls.indexOf("admin:create") < calls.indexOf("store:ref"));
  assert.deepEqual(stored, [
    { supabaseProjectRef: null, supabaseDbPassword: password },
    { supabaseProjectRef: "newprojectref0000000", supabaseDbPassword: password },
  ]);
  assert.ok(calls.includes("admin:wait:newprojectref0000000"));
  assert.equal(JSON.stringify(result).includes(password), false);
});

test("atomic migration failures stop immediately", async () => {
  const { provisionSupabase } = await loadSetupModule();
  assert.equal(typeof provisionSupabase, "function");
  const firstCalls = [];
  await assert.rejects(provisionSupabase(
    { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" },
    {
      admin: createAdmin(firstCalls, {
        migracionesAplicadas: async () => new Set(),
        async aplicarMigracion(_ref, migration) {
          firstCalls.push(`admin:migrate:${migration.sql}`);
          return { ok: migration.sql !== "select 1", error: "broken migration" };
        },
      }),
      workspace: createWorkspace(firstCalls),
      credentialStore: { update: async () => {} },
    },
  ), /migraci/u);
  assert.equal(firstCalls.includes("admin:migrate:select 2"), false);
});

test("schema verification failure is terminal and Auth distinguishes local, tunnel, and stable URLs", async () => {
  const { provisionSupabase } = await loadSetupModule();
  assert.equal(typeof provisionSupabase, "function");
  const failureCalls = [];
  await assert.rejects(provisionSupabase(
    { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" },
    {
      admin: createAdmin(failureCalls, {
        async sql(_ref, sql) { return { ok: sql !== "verify schema", error: "schema mismatch" }; },
      }),
      workspace: createWorkspace(failureCalls),
      credentialStore: { update: async () => {} },
    },
  ), /esquema/u);
  assert.equal(failureCalls.some((call) => call.startsWith("admin:auth:")), false);

  for (const [publicUrl, expected] of [
    ["http://localhost:3000", true],
    ["https://demo.trycloudflare.com", true],
    ["https://crm.example.com", false],
  ]) {
    const calls = [];
    await provisionSupabase(
      { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl },
      {
        admin: createAdmin(calls),
        workspace: createWorkspace(calls),
        credentialStore: { update: async () => {} },
      },
    );
    assert.ok(calls.includes(`admin:auth:${expected}`));
  }
});

test("progress and result payloads are allowlisted and never expose secrets", async () => {
  const { provisionSupabase, PROGRESS_STAGES } = await loadSetupModule();
  assert.equal(typeof provisionSupabase, "function");
  assert.ok(PROGRESS_STAGES instanceof Set);
  const calls = [];
  const events = [];
  const result = await provisionSupabase(
    { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" },
    {
      admin: createAdmin(calls),
      workspace: createWorkspace(calls),
      credentialStore: { update: async () => {} },
      onProgress: (event) => events.push(event),
    },
  );
  const serialized = JSON.stringify({ events, result });
  for (const secret of ["anon-secret", "service-secret", "generated-app-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(events.every((event) => PROGRESS_STAGES.has(event.stage)), true);
  assert.equal(events.every((event) => Object.keys(event).every((key) => ["stage", "message", "current", "total"].includes(key))), true);
});
