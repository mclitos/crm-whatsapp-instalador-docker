import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import filesystem from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
    (error) => {
      assert.ok(error instanceof EncryptedStoreError);
      assert.equal(error.message, "No pude leer las credenciales cifradas. El archivo puede estar dañado o haber sido modificado.");
      assert.equal(error.message.includes("sbp_tamper-test"), false);
      return true;
    },
  );
});

const permissionMessage = "No pude leer las credenciales cifradas por falta de permisos. Revisá los permisos del directorio de datos y sus archivos. No borres la clave maestra ni las credenciales.";
const readOnlyMessage = "No pude acceder a las credenciales cifradas: el sistema de archivos es de solo lectura. Revisá el montaje del volumen de datos; para ejecutar el instalador tiene que permitir escritura. No borres la clave maestra ni las credenciales.";

for (const code of ["EACCES", "EPERM", "EROFS"]) {
  for (const file of ["master.key", "supabase-connection.enc.json"]) {
    test(`${code} reading ${file} is actionable without claiming corrupted credentials`, async (t) => {
      const { directory, store } = await createStore();
      const credentials = { supabaseAccessToken: "sbp_private-permission-token", supabaseProjectRef: null };
      await store.save(credentials);
      const keyPath = join(directory, "master.key");
      const encryptedPath = join(directory, "supabase-connection.enc.json");
      const previousKey = await readFile(keyPath);
      const previousEncrypted = await readFile(encryptedPath);
      const originalRead = filesystem.readFile;
      const injected = Object.assign(new Error("private-token-and-filesystem-details"), { code });
      t.mock.method(filesystem, "readFile", async (path, ...args) => {
        if (path === join(directory, file)) throw injected;
        return originalRead(path, ...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(store.load({ createKey: false }), (error) => {
          assert.ok(error instanceof EncryptedStoreError);
          assert.equal(error.message, code === "EROFS" ? readOnlyMessage : permissionMessage);
          assert.equal(error.cause, injected);
          assert.equal(/dañado|modificado|private-token|sbp_private|master\.key/u.test(error.message), false);
          return true;
        });
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.deepEqual(await readFile(keyPath), previousKey);
      assert.deepEqual(await readFile(encryptedPath), previousEncrypted);
      assert.deepEqual(await store.load({ createKey: false }), { ...credentials, supabaseDbPassword: null });
    });
  }
}

test("default load reports a read-only chmod failure without replacing encrypted data or key", async (t) => {
  if (process.platform === "win32") { t.skip("chmod normalization is not used on Windows"); return; }
  const { directory, store } = await createStore();
  await store.save({ supabaseAccessToken: "sbp_read-only-token", supabaseProjectRef: null });
  const keyPath = join(directory, "master.key");
  const encryptedPath = join(directory, "supabase-connection.enc.json");
  const previousKey = await readFile(keyPath);
  const previousEncrypted = await readFile(encryptedPath);
  const originalChmod = filesystem.chmod;
  t.mock.method(filesystem, "chmod", async (path, ...args) => {
    if (path === directory) throw Object.assign(new Error("private-volume-details"), { code: "EROFS" });
    return originalChmod(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.load(), (error) => {
      assert.ok(error instanceof EncryptedStoreError);
      assert.equal(error.message, readOnlyMessage);
      assert.equal(error.cause.code, "EROFS");
      return true;
    });
    assert.equal((await store.load({ createKey: false })).supabaseAccessToken, "sbp_read-only-token");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(keyPath), previousKey);
  assert.deepEqual(await readFile(encryptedPath), previousEncrypted);
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
