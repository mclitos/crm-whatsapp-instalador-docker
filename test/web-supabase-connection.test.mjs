import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConnectionError,
  InputValidationError,
  connectSupabase,
  validateConnectionInput,
} from "../scripts/web/supabase-connection.mjs";

test("connection input requires a plausible Supabase personal access token", () => {
  for (const input of [null, {}, { supabaseAccessToken: "" }, { supabaseAccessToken: "not-a-token" }]) {
    assert.throws(() => validateConnectionInput(input), InputValidationError);
  }
});

test("connection input normalizes an optional valid project ref", () => {
  assert.deepEqual(
    validateConnectionInput({
      supabaseAccessToken: "  sbp_valid-token_123  ",
      supabaseProjectRef: "  abcdefghijklmnopqrst  ",
    }),
    {
      supabaseAccessToken: "sbp_valid-token_123",
      supabaseProjectRef: "abcdefghijklmnopqrst",
    },
  );
  assert.throws(
    () => validateConnectionInput({
      supabaseAccessToken: "sbp_valid-token_123",
      supabaseProjectRef: "invalid/ref",
    }),
    InputValidationError,
  );
});

test("successful validation lists organizations, validates the project, and persists credentials", async () => {
  const calls = [];
  const saved = [];
  const token = "sbp_success-secret";
  const projectRef = "abcdefghijklmnopqrst";
  const result = await connectSupabase(
    { supabaseAccessToken: token, supabaseProjectRef: projectRef },
    {
      createAdmin(receivedToken) {
        assert.equal(receivedToken, token);
        return {
          async organizaciones() {
            calls.push("organizations");
            return { ok: true, json: [{ slug: "example" }] };
          },
          async proyecto(receivedRef) {
            calls.push(`project:${receivedRef}`);
            return {
              ok: true,
              json: { name: "CRM", status: "ACTIVE_HEALTHY", region: "sa-east-1" },
            };
          },
        };
      },
      store: { async save(credentials) { saved.push(credentials); } },
    },
  );

  assert.deepEqual(calls, ["organizations", `project:${projectRef}`]);
  assert.deepEqual(saved, [{ supabaseAccessToken: token, supabaseProjectRef: projectRef }]);
  assert.deepEqual(result, {
    organizationCount: 1,
    project: {
      ref: projectRef,
      name: "CRM",
      status: "ACTIVE_HEALTHY",
      region: "sa-east-1",
    },
  });
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("failed organization validation is actionable and does not persist", async () => {
  let saved = false;
  await assert.rejects(
    connectSupabase(
      { supabaseAccessToken: "sbp_rejected-secret", supabaseProjectRef: "" },
      {
        createAdmin: () => ({
          organizaciones: async () => ({ ok: false, status: 401, error: "Unauthorized" }),
        }),
        store: { async save() { saved = true; } },
      },
    ),
    (error) => error instanceof ConnectionError
      && error.statusCode === 401
      && /token/i.test(error.publicMessage)
      && !error.publicMessage.includes("sbp_rejected-secret"),
  );
  assert.equal(saved, false);
});

test("a missing supplied project is rejected without persisting", async () => {
  let saved = false;
  await assert.rejects(
    connectSupabase(
      {
        supabaseAccessToken: "sbp_valid-but-project-missing",
        supabaseProjectRef: "abcdefghijklmnopqrst",
      },
      {
        createAdmin: () => ({
          organizaciones: async () => ({ ok: true, json: [] }),
          proyecto: async () => ({ ok: false, status: 404, error: "Not found" }),
        }),
        store: { async save() { saved = true; } },
      },
    ),
    (error) => error instanceof ConnectionError
      && error.statusCode === 422
      && /proyecto/i.test(error.publicMessage),
  );
  assert.equal(saved, false);
});

test("refreshing a connection without a project ref does not erase the stored project password", async () => {
  const updates = [];
  await connectSupabase(
    { supabaseAccessToken: "sbp_refreshed-secret", supabaseProjectRef: "" },
    {
      createAdmin: () => ({
        organizaciones: async () => ({ ok: true, json: [{ slug: "team" }] }),
      }),
      store: { async update(patch) { updates.push(patch); } },
    },
  );

  assert.deepEqual(updates, [{ supabaseAccessToken: "sbp_refreshed-secret" }]);
});
