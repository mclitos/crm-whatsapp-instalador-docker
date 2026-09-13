import assert from "node:assert/strict";
import { test } from "node:test";

import { loadSupabaseOptions } from "../scripts/web/supabase-options.mjs";

test("Supabase options load the encrypted token and expose only selectable account fields", async () => {
  const token = "sbp_options-secret";
  let receivedToken;
  const result = await loadSupabaseOptions({
    credentialStore: {
      async load() {
        return {
          supabaseAccessToken: token,
          supabaseProjectRef: null,
          supabaseDbPassword: "database-password-secret",
        };
      },
    },
    createAdmin(candidate) {
      receivedToken = candidate;
      return {
        organizaciones: async () => ({
          ok: true,
          json: [{ slug: "team", name: "Team", billing_email: "private@example.com" }],
        }),
        proyectos: async () => ({
          ok: true,
          json: [{ id: "abcdefghijklmnopqrst", name: "CRM", region: "sa-east-1", status: "ACTIVE_HEALTHY", database: { password: "private" } }],
        }),
      };
    },
  });

  assert.equal(receivedToken, token);
  assert.deepEqual(result, {
    organizations: [{ slug: "team", name: "Team" }],
    projects: [{ ref: "abcdefghijklmnopqrst", name: "CRM", region: "sa-east-1", status: "ACTIVE_HEALTHY" }],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("database-password-secret"), false);
  assert.equal(serialized.includes("private@example.com"), false);
});
