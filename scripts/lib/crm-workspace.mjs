import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  computeReadinessMetadata,
  parseReadinessMarker,
  READY_MARKER_NAME,
} from "./crm-readiness.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKSPACE = resolve(PROJECT_ROOT, "crm");
const CLONE_TRANSFER_MARKER = ".installer-clone.json";
const CLONE_TEMPORARY_DIRECTORY = /^\.clone-tmp-[a-f0-9]{16}$/u;

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const secureMode = async (path, mode) => {
  if (process.platform !== "win32") await chmod(path, mode);
};

const defaultGitRunner = async (args) => {
  await execFileAsync("git", args, { maxBuffer: 1024 * 1024 });
};

const parseAssignment = (line) => {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  return match ? { key: match[1], value: match[2] } : null;
};

const mergeEnvContents = (contents, updates) => {
  const updateEntries = new Map(Object.entries(updates));
  const written = new Set();
  const lines = contents ? contents.replace(/\n$/u, "").split("\n") : [];
  const merged = [];
  for (const line of lines) {
    const assignment = parseAssignment(line);
    if (!assignment || !updateEntries.has(assignment.key)) {
      merged.push(line);
      continue;
    }
    if (written.has(assignment.key)) continue;
    merged.push(`${assignment.key}=${updateEntries.get(assignment.key)}`);
    written.add(assignment.key);
  }
  if (merged.length && merged.at(-1) !== "") merged.push("");
  for (const [key, value] of updateEntries) {
    if (!written.has(key)) merged.push(`${key}=${value}`);
  }
  return `${merged.join("\n")}\n`;
};

export const resolveCrmWorkspaceDir = (environment = process.env) => {
  const configured = typeof environment.CRM_WORKSPACE_DIR === "string"
    ? environment.CRM_WORKSPACE_DIR.trim()
    : "";
  return resolve(configured || DEFAULT_WORKSPACE);
};

export class CrmWorkspaceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CrmWorkspaceError";
  }
}

export class CrmWorkspace {
  constructor({
    directory = resolveCrmWorkspaceDir(),
    gitRunner = defaultGitRunner,
    randomSecret = (bytes = 32) => randomBytes(bytes).toString("hex"),
  } = {}) {
    this.directory = resolve(directory);
    this.gitRunner = gitRunner;
    this.randomSecret = randomSecret;
  }

  async isValidCheckout(directory = this.directory) {
    return (await exists(resolve(directory, ".git")))
      && (await exists(resolve(directory, "supabase", "migrations")));
  }

  async ensure(repoUrl) {
    if (await this.isValidCheckout()) return { directory: this.directory, cloned: false };

    const targetExists = await exists(this.directory);
    if (targetExists) {
      let entries = await readdir(this.directory);
      if (entries.includes(CLONE_TRANSFER_MARKER)) {
        await this.#resumeMountedClone();
        return { directory: this.directory, cloned: true };
      }
      if (entries.length > 0 && entries.every((entry) => CLONE_TEMPORARY_DIRECTORY.test(entry))) {
        await Promise.all(entries.map((entry) => rm(resolve(this.directory, entry), {
          recursive: true,
          force: true,
        })));
        entries = [];
      }
      if (entries.length > 0) {
        throw new CrmWorkspaceError(
          "El directorio del CRM existe pero está incompleto. No lo borré: revisalo antes de reintentar.",
        );
      }
      return this.#cloneIntoMountedDirectory(repoUrl);
    }

    await mkdir(dirname(this.directory), { recursive: true });
    const temporaryDirectory = `${this.directory}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      await this.gitRunner(["clone", "--depth", "1", repoUrl, temporaryDirectory]);
      if (!(await this.isValidCheckout(temporaryDirectory))) {
        throw new CrmWorkspaceError("El repositorio clonado no contiene supabase/migrations.");
      }
      await rename(temporaryDirectory, this.directory);
      return { directory: this.directory, cloned: true };
    } catch (error) {
      throw error instanceof CrmWorkspaceError
        ? error
        : new CrmWorkspaceError("No pude clonar el repositorio del CRM.", { cause: error });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async #cloneIntoMountedDirectory(repoUrl) {
    const temporaryDirectory = resolve(this.directory, `.clone-tmp-${randomBytes(8).toString("hex")}`);
    const markerPath = resolve(this.directory, CLONE_TRANSFER_MARKER);
    let transferRecorded = false;
    try {
      await this.gitRunner(["clone", "--depth", "1", repoUrl, temporaryDirectory]);
      if (!(await this.isValidCheckout(temporaryDirectory))) {
        throw new CrmWorkspaceError("El repositorio clonado no contiene supabase/migrations.");
      }
      const entries = await readdir(temporaryDirectory);
      await writeFile(markerPath, `${JSON.stringify({
        version: 1,
        temporaryDirectory: basename(temporaryDirectory),
        entries,
      })}\n`, { mode: 0o600, flag: "wx" });
      transferRecorded = true;
      await secureMode(markerPath, 0o600);
      await this.#resumeMountedClone();
      return { directory: this.directory, cloned: true };
    } catch (error) {
      if (!transferRecorded) await rm(temporaryDirectory, { recursive: true, force: true });
      throw error instanceof CrmWorkspaceError
        ? error
        : new CrmWorkspaceError(
            transferRecorded
              ? "La copia del CRM se interrumpió. Volvé a intentar para continuarla de forma segura."
              : "No pude clonar el repositorio del CRM.",
            { cause: error },
          );
    }
  }

  async #resumeMountedClone() {
    const markerPath = resolve(this.directory, CLONE_TRANSFER_MARKER);
    let marker;
    try {
      marker = JSON.parse(await readFile(markerPath, "utf8"));
    } catch (error) {
      throw new CrmWorkspaceError(
        "La copia interrumpida del CRM no tiene un registro válido. No borré ningún archivo.",
        { cause: error },
      );
    }

    const entries = Array.isArray(marker?.entries) ? marker.entries : [];
    const uniqueEntries = new Set(entries);
    const safeEntries = entries.length > 0
      && entries.length === uniqueEntries.size
      && entries.every((entry) => (
        typeof entry === "string"
        && entry === basename(entry)
        && entry !== "."
        && entry !== ".."
        && entry !== CLONE_TRANSFER_MARKER
        && !CLONE_TEMPORARY_DIRECTORY.test(entry)
      ));
    if (marker?.version !== 1
      || !CLONE_TEMPORARY_DIRECTORY.test(marker?.temporaryDirectory || "")
      || !safeEntries) {
      throw new CrmWorkspaceError(
        "La copia interrumpida del CRM no tiene un registro seguro. No borré ningún archivo.",
      );
    }

    const rootEntries = await readdir(this.directory);
    const knownEntries = new Set([
      CLONE_TRANSFER_MARKER,
      marker.temporaryDirectory,
      ...entries,
    ]);
    if (rootEntries.some((entry) => !knownEntries.has(entry))) {
      throw new CrmWorkspaceError(
        "El directorio del CRM contiene archivos ajenos a la copia interrumpida. No borré ningún archivo.",
      );
    }

    const temporaryDirectory = resolve(this.directory, marker.temporaryDirectory);
    for (const entry of entries) {
      const source = resolve(temporaryDirectory, entry);
      const destination = resolve(this.directory, entry);
      const [sourceExists, destinationExists] = await Promise.all([exists(source), exists(destination)]);
      if (sourceExists && !destinationExists) {
        await rename(source, destination);
        continue;
      }
      if (!sourceExists && destinationExists) continue;
      throw new CrmWorkspaceError(
        "La copia interrumpida del CRM es ambigua. No borré ningún archivo.",
      );
    }
    if (!(await this.isValidCheckout())) {
      throw new CrmWorkspaceError(
        "La copia reanudada no contiene un checkout válido. No borré ningún archivo.",
      );
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
    await rm(markerPath, { force: true });
  }

  async readMigrations() {
    const migrationsDirectory = resolve(this.directory, "supabase", "migrations");
    let fileNames;
    try {
      fileNames = (await readdir(migrationsDirectory))
        .filter((fileName) => fileName.endsWith(".sql"))
        .sort();
    } catch (error) {
      throw new CrmWorkspaceError("No pude leer las migraciones del CRM.", { cause: error });
    }
    if (fileNames.length === 0) throw new CrmWorkspaceError("El CRM no contiene migraciones SQL.");
    return Promise.all(fileNames.map(async (fileName) => ({
      fileName,
      version: fileName.split("_")[0],
      name: fileName.replace(/^\d+_/u, "").replace(/\.sql$/u, ""),
      sql: await readFile(resolve(migrationsDirectory, fileName), "utf8"),
    })));
  }

  async readVerifySchema() {
    const path = resolve(this.directory, "supabase", "ci", "verify-schema.sql");
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new CrmWorkspaceError("No pude leer la verificación del esquema.", { cause: error });
    }
  }

  async detectLocale() {
    try {
      const locales = (await readdir(resolve(this.directory, "messages")))
        .filter((fileName) => fileName.endsWith(".json"))
        .map((fileName) => fileName.replace(/\.json$/u, ""));
      return locales.includes("es") ? "es" : locales[0] || "en";
    } catch (error) {
      if (error.code === "ENOENT") return "en";
      throw error;
    }
  }

  async writeEnvironment({
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    publicUrl,
    locale,
    metaAppId = "",
    metaAppSecret = "",
  }) {
    const path = resolve(this.directory, ".env.local");
    let previous = "";
    try {
      previous = await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const previousValues = Object.fromEntries(previous.split("\n").flatMap((line) => {
      const assignment = parseAssignment(line);
      return assignment ? [[assignment.key, assignment.value]] : [];
    }));
    const updates = {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      ENCRYPTION_KEY: previousValues.ENCRYPTION_KEY || this.randomSecret(32),
      AUTOMATION_CRON_SECRET: previousValues.AUTOMATION_CRON_SECRET || this.randomSecret(32),
      META_APP_SECRET: metaAppSecret,
      META_APP_ID: metaAppId,
      NEXT_PUBLIC_SITE_URL: publicUrl || "http://localhost:3000",
      NEXT_PUBLIC_APP_LOCALE: locale,
    };
    const temporaryPath = resolve(this.directory, `.env.local.tmp-${randomBytes(8).toString("hex")}`);
    try {
      await writeFile(temporaryPath, mergeEnvContents(previous, updates), { mode: 0o600, flag: "wx" });
      await secureMode(temporaryPath, 0o600);
      await rename(temporaryPath, path);
      await secureMode(path, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async clearReady() {
    await rm(resolve(this.directory, READY_MARKER_NAME), { force: true });
  }

  async markReady({ now = new Date() } = {}) {
    const path = resolve(this.directory, READY_MARKER_NAME);
    const metadata = await computeReadinessMetadata(this.directory, { now });
    try {
      const existing = parseReadinessMarker(await readFile(path, "utf8"));
      if (existing.fingerprint === metadata.fingerprint) {
        await secureMode(path, 0o600);
        return { marker: existing, reused: true };
      }
    } catch (error) {
      if (error.code && error.code !== "ENOENT") throw error;
    }

    const temporaryPath = resolve(this.directory, `${READY_MARKER_NAME}.tmp-${randomBytes(8).toString("hex")}`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await secureMode(temporaryPath, 0o600);
      await rename(temporaryPath, path);
      await secureMode(path, 0o600);
      return { marker: metadata, reused: false };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
