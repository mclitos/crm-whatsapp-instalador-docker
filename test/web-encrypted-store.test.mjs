import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  EncryptedCredentialStore,
  EncryptedStoreError,
} from "../scripts/web/encrypted-store.mjs";

const temporaryDirectories = [];

const createStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), "crm-installer-store-"));
  temporaryDirectories.push(directory);
  return { directory, store: new EncryptedCredentialStore({ directory }) };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

test("encrypted credentials survive a save and load roundtrip", async () => {
  const { store } = await createStore();
  const credentials = {
    supabaseAccessToken: "sbp_roundtrip-secret-token",
    supabaseProjectRef: "abcdefghijklmnopqrst",
    supabaseDbPassword: "database-password-secret",
  };

  await store.save(credentials);

  assert.deepEqual(await store.load(), credentials);
});

test("legacy v1 payloads without a database password load with null", async () => {
  const { directory, store } = await createStore();
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("crm-whatsapp-installer:supabase-connection:v1", "utf8"));
  const plaintext = Buffer.from(JSON.stringify({
    supabaseAccessToken: "sbp_legacy-token",
    supabaseProjectRef: "abcdefghijklmnopqrst",
  }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  await writeFile(join(directory, "master.key"), key, { mode: 0o600 });
  await writeFile(join(directory, "supabase-connection.enc.json"), JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));

  assert.deepEqual(await store.load(), {
    supabaseAccessToken: "sbp_legacy-token",
    supabaseProjectRef: "abcdefghijklmnopqrst",
    supabaseDbPassword: null,
  });
});

test("connection updates preserve a same-project password and clear it when the project changes", async () => {
  const { store } = await createStore();
  await store.save({
    supabaseAccessToken: "sbp_initial-token",
    supabaseProjectRef: "abcdefghijklmnopqrst",
    supabaseDbPassword: "database-password-secret",
  });

  await store.update({
    supabaseAccessToken: "sbp_refreshed-token",
    supabaseProjectRef: "abcdefghijklmnopqrst",
  });
  assert.equal((await store.load()).supabaseDbPassword, "database-password-secret");

  await store.update({ supabaseProjectRef: "zyxwvutsrqponmlkjihg" });
  assert.equal((await store.load()).supabaseDbPassword, null);
});

test("the encrypted file never contains the Supabase token", async () => {
  const { directory, store } = await createStore();
  const token = "sbp_token-that-must-not-appear-on-disk";
  const password = "database-password-that-must-not-appear-on-disk";

  await store.save({
    supabaseAccessToken: token,
    supabaseProjectRef: null,
    supabaseDbPassword: password,
  });

  const encrypted = await readFile(join(directory, "supabase-connection.enc.json"), "utf8");
  assert.equal(encrypted.includes(token), false);
  assert.equal(encrypted.includes(password), false);
});

test("tampered ciphertext is rejected with a safe store error", async () => {
  const { directory, store } = await createStore();
  const storePath = join(directory, "supabase-connection.enc.json");
  await store.save({ supabaseAccessToken: "sbp_tamper-test", supabaseProjectRef: null });
  const payload = JSON.parse(await readFile(storePath, "utf8"));
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  ciphertext[0] ^= 1;
  payload.ciphertext = ciphertext.toString("base64");
  await writeFile(storePath, JSON.stringify(payload), "utf8");

  await assert.rejects(
    store.load(),
    (error) => error instanceof EncryptedStoreError && !error.message.includes("sbp_tamper-test"),
  );
});

test("the key directory and secret files use restrictive permissions", async () => {
  if (process.platform === "win32") return;
  const { directory, store } = await createStore();
  await store.save({ supabaseAccessToken: "sbp_permissions", supabaseProjectRef: null });

  const directoryMode = (await stat(directory)).mode & 0o777;
  const keyMode = (await stat(join(directory, "master.key"))).mode & 0o777;
  const storeMode = (await stat(join(directory, "supabase-connection.enc.json"))).mode & 0o777;

  assert.equal(directoryMode, 0o700);
  assert.equal(keyMode, 0o600);
  assert.equal(storeMode, 0o600);
});

test("the data directory can be selected through the environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crm-installer-env-store-"));
  temporaryDirectories.push(directory);

  const store = new EncryptedCredentialStore({
    environment: { WEB_INSTALLER_DATA_DIR: directory },
  });

  assert.equal(store.directory, directory);
});
