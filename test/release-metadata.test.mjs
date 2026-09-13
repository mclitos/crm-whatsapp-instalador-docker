import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { startWebInstaller } from "../scripts/web/server.mjs";

test("LICENSE distinguishes the original CRM, maintained default source, and override", async () => {
  const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");

  assert.match(license, /ArnasDon\/wacrm.*original/isu);
  assert.match(license, /mclitos\/wacrm.*mantenid/isu);
  assert.match(license, /CRM_REPO_URL/u);
  assert.doesNotMatch(license, /from its official repository/iu);
});

test("README LAN setup token is accepted by the runtime validator", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const setupToken = readme.match(/^WEB_INSTALLER_SETUP_TOKEN=(.+)$/mu)?.[1];

  assert.ok(setupToken, "README must document a LAN setup token");
  const server = await startWebInstaller({ port: 0, setupToken });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
