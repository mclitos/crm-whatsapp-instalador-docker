import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const AAD = Buffer.from("crm-whatsapp-installer:supabase-connection:v1", "utf8");
const DEFAULT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".web-installer",
);

export class EncryptedStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EncryptedStoreError";
  }
}

const secureMode = async (path, mode) => {
  if (process.platform === "win32") return;
  await chmod(path, mode);
};

const decodeField = (payload, field, expectedLength) => {
  if (typeof payload[field] !== "string" || payload[field].length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  const value = Buffer.from(payload[field], "base64");
  if (expectedLength && value.length !== expectedLength) throw new Error(`Invalid ${field}`);
  return value;
};

const validateCredentials = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid data");
  if (typeof value.supabaseAccessToken !== "string" || value.supabaseAccessToken.length === 0) {
    throw new Error("Invalid token");
  }
  if (value.supabaseProjectRef !== null && typeof value.supabaseProjectRef !== "string") {
    throw new Error("Invalid project ref");
  }
  if (value.supabaseDbPassword !== undefined
    && value.supabaseDbPassword !== null
    && typeof value.supabaseDbPassword !== "string") {
    throw new Error("Invalid database password");
  }
  return {
    supabaseAccessToken: value.supabaseAccessToken,
    supabaseProjectRef: value.supabaseProjectRef,
    supabaseDbPassword: value.supabaseDbPassword || null,
  };
};

const hasErrorCode = (error, code) => {
  let current = error;
  while (current) {
    if (current.code === code) return true;
    current = current.cause;
  }
  return false;
};

export class EncryptedCredentialStore {
  constructor({ directory, environment = process.env } = {}) {
    const configuredDirectory = typeof environment.WEB_INSTALLER_DATA_DIR === "string"
      ? environment.WEB_INSTALLER_DATA_DIR.trim()
      : "";
    this.directory = resolve(directory || configuredDirectory || DEFAULT_DIRECTORY);
    this.keyPath = resolve(this.directory, "master.key");
    this.storePath = resolve(this.directory, "supabase-connection.enc.json");
  }

  async save(credentials) {
    const normalized = validateCredentials(credentials);
    const key = await this.#readOrCreateKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(normalized), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const payload = {
      version: STORE_VERSION,
      algorithm: ALGORITHM,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporaryPath = resolve(this.directory, `.supabase-connection.${randomBytes(8).toString("hex")}.tmp`);

    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await secureMode(temporaryPath, 0o600);
      await rename(temporaryPath, this.storePath);
      await secureMode(this.storePath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async update(patch) {
    let current;
    try {
      current = await this.load();
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      current = null;
    }

    const nextProjectRef = Object.hasOwn(patch, "supabaseProjectRef")
      ? patch.supabaseProjectRef
      : current?.supabaseProjectRef ?? null;
    const projectChanged = Boolean(current)
      && Object.hasOwn(patch, "supabaseProjectRef")
      && current.supabaseProjectRef !== nextProjectRef;
    const nextPassword = Object.hasOwn(patch, "supabaseDbPassword")
      ? patch.supabaseDbPassword
      : projectChanged
        ? null
        : current?.supabaseDbPassword ?? null;

    await this.save({
      supabaseAccessToken: patch.supabaseAccessToken ?? current?.supabaseAccessToken,
      supabaseProjectRef: nextProjectRef,
      supabaseDbPassword: nextPassword,
    });
  }

  async load({ createKey = true } = {}) {
    try {
      const [key, serialized] = await Promise.all([
        createKey ? this.#readOrCreateKey() : readFile(this.keyPath),
        readFile(this.storePath, "utf8"),
      ]);
      if (key.length !== 32) throw new Error("Invalid master key");
      const payload = JSON.parse(serialized);
      if (payload.version !== STORE_VERSION || payload.algorithm !== ALGORITHM) {
        throw new Error("Unsupported encrypted payload");
      }
      const iv = decodeField(payload, "iv", 12);
      const authTag = decodeField(payload, "authTag", 16);
      const ciphertext = decodeField(payload, "ciphertext");
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return validateCredentials(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      throw new EncryptedStoreError(
        "No pude leer las credenciales cifradas. El archivo puede estar dañado o haber sido modificado.",
        { cause: error },
      );
    }
  }

  async #readOrCreateKey() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await secureMode(this.directory, 0o700);

    let key;
    try {
      key = await readFile(this.keyPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const generated = randomBytes(32);
      try {
        await writeFile(this.keyPath, generated, { mode: 0o600, flag: "wx" });
        key = generated;
      } catch (writeError) {
        if (writeError.code !== "EEXIST") throw writeError;
        key = await readFile(this.keyPath);
      }
    }

    await secureMode(this.keyPath, 0o600);
    if (key.length !== 32) {
      throw new EncryptedStoreError("La clave maestra local no tiene un formato válido.");
    }
    return key;
  }
}
