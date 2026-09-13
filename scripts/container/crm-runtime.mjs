import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  BUILD_MARKER_NAME,
  computeWorkspaceBuildInputMetadata,
  parseReadinessMarker,
  READY_MARKER_NAME,
  sha256,
  validateReadinessMarker,
} from "../lib/crm-readiness.mjs";

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const BUILD_MARKER_KEYS = ["builtAt", "fingerprint", "sourceRevision", "version"];
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^[a-f0-9]{7,64}$/u;

const pathExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const fileExists = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const directoryExists = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const replaceDirectory = async (source, destination) => {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
};

const replaceDirectoryIfPresent = async (source, destination) => {
  if (await directoryExists(source)) await replaceDirectory(source, destination);
  else await rm(destination, { recursive: true, force: true });
};

const prepareStandaloneRuntime = async (directory) => {
  const standaloneDirectory = resolve(directory, ".next", "standalone");
  const serverPath = resolve(standaloneDirectory, "server.js");
  const staticDirectory = resolve(directory, ".next", "static");
  if (!(await fileExists(serverPath))) {
    throw new Error(
      'El build terminó, pero falta .next/standalone/server.js. Verificá que next.config use output: "standalone" y volvé a construir.',
    );
  }
  if (!(await directoryExists(staticDirectory))) {
    throw new Error(
      "El build terminó, pero .next/static es requerida y falta o no es un directorio. Volvé a construir el CRM.",
    );
  }

  await replaceDirectoryIfPresent(
    resolve(directory, "public"),
    resolve(standaloneDirectory, "public"),
  );
  await replaceDirectory(
    staticDirectory,
    resolve(standaloneDirectory, ".next", "static"),
  );
};

const secureMode = async (path, mode) => {
  if (process.platform !== "win32") await chmod(path, mode);
};

const runChild = (command, args, options) => new Promise((resolveChild, reject) => {
  const child = spawn(command, args, { ...options, shell: false, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolveChild({ code, signal });
    else reject(new Error(`${command} ${args.join(" ")} terminó con código ${code ?? signal}.`));
  });
});

const startChild = (command, args, options) => new Promise((resolveChild, reject) => {
  const child = spawn(command, args, { ...options, shell: false, stdio: "inherit" });
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onTerm = () => forward("SIGTERM");
  const onInterrupt = () => forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInterrupt);
  const cleanup = () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
  };
  child.once("error", (error) => { cleanup(); reject(error); });
  child.once("exit", (code, signal) => { cleanup(); resolveChild({ code, signal }); });
});

export const waitForReadyWorkspace = async ({
  directory,
  logger = console,
  maxAttempts = 720,
  pollIntervalMs = 5000,
  sleep = delay,
} = {}) => {
  const markerPath = resolve(directory, READY_MARKER_NAME);
  let announced = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let contents;
    try {
      contents = await readFile(markerPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!announced) {
        logger.info("CRM: esperando que el instalador termine el aprovisionamiento.");
        announced = true;
      }
      if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
      continue;
    }

    const marker = parseReadinessMarker(contents);
    try {
      return await validateReadinessMarker(directory, marker);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "SyntaxError"].includes(error.code || error.name)) {
        throw new Error("El CRM se marcó listo, pero el workspace está incompleto o es inválido.", { cause: error });
      }
      throw error;
    }
  }
  throw new Error("El CRM todavía no está listo: el aprovisionamiento no terminó dentro del tiempo esperado.");
};

const readBuildMarker = async (path) => {
  try {
    const marker = JSON.parse(await readFile(path, "utf8"));
    const keys = marker && typeof marker === "object" && !Array.isArray(marker)
      ? Object.keys(marker).sort()
      : [];
    const valid = JSON.stringify(keys) === JSON.stringify(BUILD_MARKER_KEYS)
      && marker.version === 1
      && !Number.isNaN(Date.parse(marker.builtAt))
      && (marker.sourceRevision === null || GIT_REVISION.test(marker.sourceRevision))
      && SHA256.test(marker.fingerprint);
    return valid ? marker : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const writeBuildMarker = async (directory, marker) => {
  const path = resolve(directory, BUILD_MARKER_NAME);
  const temporaryPath = resolve(directory, `${BUILD_MARKER_NAME}.tmp-${randomBytes(8).toString("hex")}`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await secureMode(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await secureMode(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

export const runCrmRuntime = async ({
  directory = process.env.CRM_WORKSPACE_DIR || "/workspace/crm",
  logger = console,
  runCommand = runChild,
  startCommand = startChild,
  ...waitingOptions
} = {}) => {
  const readiness = await waitForReadyWorkspace({ directory, logger, ...waitingOptions });
  const sourceMetadata = await computeWorkspaceBuildInputMetadata(directory);
  const buildFingerprint = sha256(
    `crm-build-v2:${sourceMetadata.sourceFingerprint}:${readiness.environmentFingerprint}`,
  );
  const buildMarkerPath = resolve(directory, BUILD_MARKER_NAME);
  const buildMarker = await readBuildMarker(buildMarkerPath);
  const dependenciesExist = await pathExists(resolve(directory, "node_modules"));
  const artifactsExist = await fileExists(resolve(directory, ".next", "standalone", "server.js"));
  const staticArtifactsExist = await directoryExists(resolve(directory, ".next", "static"));
  const rebuild = buildMarker?.fingerprint !== buildFingerprint
    || !dependenciesExist
    || !artifactsExist
    || !staticArtifactsExist;
  const environment = { ...process.env, NODE_ENV: "production" };

  if (rebuild) {
    logger.info("CRM: instalando dependencias y construyendo la aplicación.");
    await rm(buildMarkerPath, { force: true });
    await runCommand("npm", ["ci", "--include=dev"], { cwd: directory, env: environment });
    await runCommand("npm", ["run", "build"], { cwd: directory, env: environment });
  } else {
    logger.info("CRM: dependencias y build vigentes; se reutilizan.");
  }

  await prepareStandaloneRuntime(directory);

  if (rebuild) {
    await writeBuildMarker(directory, {
      version: 1,
      builtAt: new Date().toISOString(),
      sourceRevision: sourceMetadata.sourceRevision,
      fingerprint: buildFingerprint,
    });
  }

  logger.info("CRM: iniciando la aplicación en http://0.0.0.0:3000.");
  return startCommand("node", [".next/standalone/server.js"], {
    cwd: directory,
    env: { ...environment, PORT: "3000", HOSTNAME: "0.0.0.0" },
  });
};
