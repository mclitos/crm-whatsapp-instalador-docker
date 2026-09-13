import assert from "node:assert/strict";
import { test } from "node:test";

import { SupabaseAdmin } from "../scripts/lib/supabase.mjs";

test("API keys use the ordinary endpoint without requesting reveal access", async () => {
  const admin = new SupabaseAdmin("sbp_test-token");
  const requestedPaths = [];
  admin.req = async (method, path) => {
    assert.equal(method, "GET");
    requestedPaths.push(path);
    if (path.endsWith("/api-keys/legacy")) {
      return { ok: true, json: { enabled: true } };
    }
    if (path.endsWith("/api-keys")) {
      return {
        ok: true,
        json: [
          { name: "anon", type: "legacy", api_key: "test-anon-key" },
          { name: "service_role", type: "legacy", api_key: "test-service-role-key" },
          { name: "publishable", type: "publishable", api_key: "test-publishable-key" },
          { name: "secret", type: "secret", api_key: "test-secret-key" },
        ],
      };
    }
    assert.fail(`Unexpected request: ${path}`);
  };

  const result = await admin.llaves("abcdefghijklmnopqrst");

  assert.deepEqual(result, {
    ok: true,
    url: "https://abcdefghijklmnopqrst.supabase.co",
    anon: "test-anon-key",
    serviceRole: "test-service-role-key",
    tipo: "legacy",
  });
  assert.deepEqual(requestedPaths, [
    "/v1/projects/abcdefghijklmnopqrst/api-keys/legacy",
    "/v1/projects/abcdefghijklmnopqrst/api-keys",
  ]);
});

test("API keys preserve old legacy endpoint responses containing values", async () => {
  const admin = new SupabaseAdmin("sbp_test-token");
  const requestedPaths = [];
  admin.req = async (method, path) => {
    assert.equal(method, "GET");
    requestedPaths.push(path);
    return {
      ok: true,
      json: {
        anon_key: "test-old-anon-key",
        service_role_key: "test-old-service-role-key",
      },
    };
  };

  const result = await admin.llaves("abcdefghijklmnopqrst");

  assert.equal(result.anon, "test-old-anon-key");
  assert.equal(result.serviceRole, "test-old-service-role-key");
  assert.deepEqual(requestedPaths, ["/v1/projects/abcdefghijklmnopqrst/api-keys/legacy"]);
});

test("API keys parse publishable and secret types without reveal access", async () => {
  const admin = new SupabaseAdmin("sbp_test-token");
  const requestedPaths = [];
  admin.req = async (_method, path) => {
    requestedPaths.push(path);
    if (path.endsWith("/api-keys/legacy")) return { ok: true, json: { enabled: true } };
    if (path.endsWith("/api-keys")) {
      return {
        ok: true,
        json: [
          { type: "publishable", api_key: "test-publishable-key" },
          { type: "secret", api_key: "test-secret-key" },
        ],
      };
    }
    assert.fail(`Unexpected request: ${path}`);
  };

  const result = await admin.llaves("abcdefghijklmnopqrst");

  assert.equal(result.anon, "test-publishable-key");
  assert.equal(result.serviceRole, "test-secret-key");
  assert.equal(result.tipo, "nuevas (publishable/secret)");
  assert.equal(requestedPaths.some((path) => path.includes("reveal=true")), false);
});

test("API keys request reveal access only when ordinary responses omit values", async () => {
  const admin = new SupabaseAdmin("sbp_test-token");
  const requestedPaths = [];
  admin.req = async (_method, path) => {
    requestedPaths.push(path);
    if (path.endsWith("/api-keys/legacy")) return { ok: true, json: { enabled: true } };
    if (path.endsWith("/api-keys")) {
      return { ok: true, json: [{ name: "anon", type: "legacy" }] };
    }
    return {
      ok: true,
      json: [
        { type: "publishable", api_key: "test-revealed-publishable-key" },
        { type: "secret", api_key: "test-revealed-secret-key" },
      ],
    };
  };

  const result = await admin.llaves("abcdefghijklmnopqrst");

  assert.equal(result.ok, true);
  assert.deepEqual(requestedPaths, [
    "/v1/projects/abcdefghijklmnopqrst/api-keys/legacy",
    "/v1/projects/abcdefghijklmnopqrst/api-keys",
    "/v1/projects/abcdefghijklmnopqrst/api-keys?reveal=true",
  ]);
});

test("migration read failures are explicit instead of looking like an empty migration set", async () => {
  const admin = new SupabaseAdmin("sbp_test-token");
  admin.sql = async () => ({ ok: false, status: 503, error: "database unavailable" });

  await assert.rejects(admin.migracionesAplicadas("abcdefghijklmnopqrst"), /migraciones|database unavailable/u);
});

test("a migration and its CLI-compatible history row use one atomic SQL request", async () => {
  const admin = new SupabaseAdmin("sbp_test-token");
  const calls = [];
  admin.sql = async (ref, query) => {
    calls.push({ ref, query });
    return { ok: true };
  };

  await admin.aplicarMigracion(
    "abcdefghijklmnopqrst",
    { version: "040", name: "owner's migration", sql: "create table example(id bigint);" },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, "abcdefghijklmnopqrst");
  assert.match(calls[0].query, /^begin;/iu);
  assert.match(calls[0].query, /create table example\(id bigint\);/iu);
  assert.match(
    calls[0].query,
    /insert into supabase_migrations\.schema_migrations \(version, name\)/iu,
  );
  assert.match(calls[0].query, /values \('040', 'owner''s migration'\)/iu);
  assert.match(calls[0].query, /commit;\s*$/iu);
});
