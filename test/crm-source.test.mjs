import assert from "node:assert/strict";
import { test } from "node:test";

const loadResolver = async () => {
  try {
    return await import("../scripts/lib/crm-source.mjs");
  } catch {
    return {};
  }
};

test("the CRM source defaults to the maintained fork", async () => {
  const { resolveCrmRepoUrl } = await loadResolver();

  assert.equal(typeof resolveCrmRepoUrl, "function");
  assert.equal(
    resolveCrmRepoUrl({ environment: {}, credentials: {} }),
    "https://github.com/mclitos/wacrm.git",
  );
});

test("the CRM source prefers environment over credentials over the default", async () => {
  const { resolveCrmRepoUrl } = await loadResolver();
  const credentials = { CRM_REPO_URL: "https://example.com/from-credentials.git" };

  assert.equal(
    resolveCrmRepoUrl({ environment: {}, credentials }),
    credentials.CRM_REPO_URL,
  );
  assert.equal(
    resolveCrmRepoUrl({
      environment: { CRM_REPO_URL: "https://example.com/from-environment.git" },
      credentials,
    }),
    "https://example.com/from-environment.git",
  );
});
