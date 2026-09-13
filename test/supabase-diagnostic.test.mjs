import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EncryptedCredentialStore } from "../scripts/web/encrypted-store.mjs";
import {
  collectSupabaseDiagnostic,
  inspectDockerSupabase,
  reportDockerSupabase,
} from "../scripts/lib/supabase-diagnostic.mjs";

test("Docker diagnostic uses a one-shot installer container and accepts allowlisted status only", () => {
  const secret = "sbp_diagnostic-secret";
  const calls = [];
  const diagnostic = inspectDockerSupabase({
    directory: "/installer",
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      return `${JSON.stringify({
        version: 1,
        credentials: "ready",
        project: "healthy",
        tables: { status: "complete", count: 24 },
        migrations: { status: "present", count: 39 },
        auth: "configured",
      })}\n${secret}`;
    },
  });

  assert.deepEqual(calls[0].args, [
    "compose", "run", "--rm", "--no-deps", "-T", "diagnostics",
  ]);
  assert.equal(calls[0].options.cwd, "/installer");
  assert.equal(diagnostic.status, "ready");
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});

test("missing Docker credentials are diagnosed without creating key material", async () => {
  const root = await mkdtemp(join(tmpdir(), "supabase-diagnostic-test-"));
  const directory = join(root, "installer-data");
  const diagnostic = await collectSupabaseDiagnostic({
    credentialStore: new EncryptedCredentialStore({ directory }),
  });

  assert.equal(diagnostic.credentials, "unreadable");
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("container diagnostic never returns decrypted credentials or upstream response strings", async () => {
  const secret = "sbp_never-return-this-secret";
  const diagnostic = await collectSupabaseDiagnostic({
    credentialStore: {
      async load(options) {
        assert.deepEqual(options, { createKey: false });
        return { supabaseAccessToken: secret, supabaseProjectRef: "abcdefghijklmnopqrst" };
      },
    },
    createAdmin(token) {
      assert.equal(token, secret);
      return {
        async proyecto() { return { ok: true, json: { status: "ACTIVE_HEALTHY", name: secret } }; },
        async sql() { return { ok: true, json: [{ n: 24, leaked: secret }] }; },
        async migracionesAplicadas() { return new Set(["001", "002"]); },
        async authConfig() { return { ok: true, json: { site_url: "https://crm.example.com", leaked: secret } }; },
      };
    },
  });

  assert.deepEqual(diagnostic, {
    version: 1,
    credentials: "ready",
    project: "healthy",
    tables: { status: "complete", count: 24 },
    migrations: { status: "present", count: 2 },
    auth: "configured",
  });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});

test("Docker diagnostic failures recommend Docker reconfiguration, never classic paso1", () => {
  const messages = [];
  reportDockerSupabase({ status: "unavailable" }, {
    fail(message, action) { messages.push(`${message} ${action || ""}`); },
    ok(message, detail) { messages.push(`${message} ${detail || ""}`); },
    warn(message, action) { messages.push(`${message} ${action || ""}`); },
  });

  assert.match(messages.join("\n"), /docker.*reconfigur/iu);
  assert.doesNotMatch(messages.join("\n"), /paso1/iu);
});
