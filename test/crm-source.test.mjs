import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  readPinnedCrmVersion,
  resolveCrmRepoUrl,
  resolveCrmSource,
} from "../scripts/lib/crm-source.mjs";

const pinned = () => ({
  repoUrl: "https://github.com/ArnasDon/wacrm.git",
  commit: "45e80ad9e23b91f5c02ab9f935edbae67810e59d",
});

test("without overrides the CRM source is the pinned reviewed version", () => {
  assert.deepEqual(resolveCrmSource({ environment: {}, credentials: {}, pinned }), pinned());
  assert.equal(resolveCrmRepoUrl({ environment: {}, credentials: {}, pinned }), pinned().repoUrl);
});

test("an empty CRM_REPO_URL is treated as unset", () => {
  assert.deepEqual(
    resolveCrmSource({ environment: { CRM_REPO_URL: "  " }, credentials: { CRM_REPO_URL: "" }, pinned }),
    pinned(),
  );
});

test("an explicit repository prefers environment over credentials and follows its default branch", () => {
  const credentials = { CRM_REPO_URL: "https://example.com/from-credentials.git" };

  assert.deepEqual(resolveCrmSource({ environment: {}, credentials, pinned }), {
    repoUrl: credentials.CRM_REPO_URL,
    commit: null,
  });
  assert.deepEqual(
    resolveCrmSource({
      environment: { CRM_REPO_URL: "https://example.com/from-environment.git" },
      credentials,
      pinned,
    }),
    { repoUrl: "https://example.com/from-environment.git", commit: null },
  );
});

test("the tracked crm-version.json pins a full commit of the upstream repository", () => {
  const version = readPinnedCrmVersion();

  assert.equal(version.repoUrl, "https://github.com/ArnasDon/wacrm.git");
  assert.equal(version.commit, "45e80ad9e23b91f5c02ab9f935edbae67810e59d");
});

test("an invalid crm-version.json fails with an actionable message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crm-source-test-"));
  try {
    const path = join(directory, "crm-version.json");
    await writeFile(path, JSON.stringify({ repo: "https://example.com/x.git", commit: "abc" }));
    assert.throws(() => readPinnedCrmVersion(path), /un `commit` completo/u);
    await writeFile(path, "{no es json");
    assert.throws(() => readPinnedCrmVersion(path), /crm-version\.json/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
