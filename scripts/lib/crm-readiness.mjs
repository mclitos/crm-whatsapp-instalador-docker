import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { promisify } from "node:util";

export const READY_MARKER_NAME = ".installer-ready.json";
export const BUILD_MARKER_NAME = ".installer-build.json";
export const READINESS_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^[a-f0-9]{7,64}$/u;
const execFileAsync = promisify(execFile);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".cache",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "temp",
  "tmp",
]);
const READY_KEYS = [
  "environmentFingerprint",
  "fingerprint",
  "readyAt",
  "sourceFingerprint",
  "sourceRevision",
  "version",
];

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const fingerprintPublicEnvironment = (contents) => sha256(contents
  .split("\n")
  .filter((line) => /^NEXT_PUBLIC_[A-Za-z0-9_]+=/.test(line))
  .sort()
  .join("\n"));

const normalizeInventoryPath = (filePath) => {
  const normalized = posix.normalize(filePath);
  if (!normalized || normalized === "." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new Error("Invalid CRM source inventory path");
  }
  return normalized;
};

const isExcludedBuildInput = (filePath) => {
  const segments = filePath.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return true;
  const fileName = segments.at(-1);
  return fileName.startsWith(".env")
    || fileName === READY_MARKER_NAME
    || fileName === BUILD_MARKER_NAME
    || fileName.startsWith(`${READY_MARKER_NAME}.tmp-`)
    || fileName.startsWith(`${BUILD_MARKER_NAME}.tmp-`)
    || fileName.endsWith(".log")
    || fileName.endsWith(".pid")
    || fileName.endsWith(".tmp");
};

const hashRegularFile = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const hashInventoryEntry = async (directory, filePath) => {
  const path = resolve(directory, filePath);
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
  if (details.isSymbolicLink()) return `symlink:${sha256(await readlink(path))}`;
  if (!details.isFile()) throw new Error("Unsupported CRM source inventory entry");
  try {
    return `file:${await hashRegularFile(path)}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
};

const readGitDirectory = async (directory) => {
  const dotGit = resolve(directory, ".git");
  const details = await stat(dotGit);
  if (details.isDirectory()) return dotGit;
  const pointer = await readFile(dotGit, "utf8");
  const match = pointer.trim().match(/^gitdir:\s*(.+)$/u);
  if (!match) return null;
  return resolve(dirname(dotGit), match[1]);
};

export const readSourceRevision = async (directory) => {
  try {
    const gitDirectory = await readGitDirectory(directory);
    if (!gitDirectory) return null;
    const head = (await readFile(resolve(gitDirectory, "HEAD"), "utf8")).trim();
    const reference = head.match(/^ref:\s*(.+)$/u)?.[1];
    let revision = head;
    if (reference) {
      try {
        revision = (await readFile(resolve(gitDirectory, reference), "utf8")).trim();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const packedRefs = await readFile(resolve(gitDirectory, "packed-refs"), "utf8");
        revision = packedRefs.split("\n")
          .map((line) => line.trim().split(" "))
          .find(([, name]) => name === reference)?.[0] || "";
      }
    }
    return GIT_REVISION.test(revision) ? revision : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
};

export const computeWorkspaceBuildInputMetadata = async (directory) => {
  try {
    const [{ stdout }, sourceRevision] = await Promise.all([
      execFileAsync(
        "git",
        ["-C", directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
      readSourceRevision(directory),
    ]);
    const filePaths = [...new Set(stdout
      .split("\0")
      .filter(Boolean)
      .map(normalizeInventoryPath)
      .filter((filePath) => !isExcludedBuildInput(filePath)))]
      .sort();
    const fingerprint = createHash("sha256");
    fingerprint.update(`crm-build-input-v1\0${sourceRevision || "none"}\0`);
    for (const filePath of filePaths) {
      const entryFingerprint = await hashInventoryEntry(directory, filePath);
      fingerprint.update(`${filePath}\0${entryFingerprint}\0`);
    }
    return { sourceRevision, sourceFingerprint: fingerprint.digest("hex") };
  } catch (error) {
    throw new Error(
      "No pude establecer el inventario seguro del código del CRM. Revisá que el checkout de Git y el volumen sean legibles.",
      { cause: error },
    );
  }
};

export const computeReadinessMetadata = async (directory, { now = new Date() } = {}) => {
  const [packageJson, packageLock, environment, sourceMetadata] = await Promise.all([
    readFile(resolve(directory, "package.json"), "utf8"),
    readFile(resolve(directory, "package-lock.json"), "utf8"),
    readFile(resolve(directory, ".env.local"), "utf8"),
    computeWorkspaceBuildInputMetadata(directory),
  ]);
  JSON.parse(packageJson);
  JSON.parse(packageLock);
  const environmentFingerprint = fingerprintPublicEnvironment(environment);
  return {
    version: READINESS_VERSION,
    readyAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    sourceRevision: sourceMetadata.sourceRevision,
    sourceFingerprint: sourceMetadata.sourceFingerprint,
    environmentFingerprint,
    fingerprint: sha256(`${sourceMetadata.sourceFingerprint}:${environmentFingerprint}`),
  };
};

export const parseReadinessMarker = (contents) => {
  let marker;
  try {
    marker = JSON.parse(contents);
  } catch {
    throw new Error("El marcador de readiness del CRM no contiene JSON válido.");
  }
  const keys = marker && typeof marker === "object" && !Array.isArray(marker)
    ? Object.keys(marker).sort()
    : [];
  const valid = JSON.stringify(keys) === JSON.stringify(READY_KEYS)
    && marker.version === READINESS_VERSION
    && !Number.isNaN(Date.parse(marker.readyAt))
    && (marker.sourceRevision === null || GIT_REVISION.test(marker.sourceRevision))
    && SHA256.test(marker.sourceFingerprint)
    && SHA256.test(marker.environmentFingerprint)
    && SHA256.test(marker.fingerprint);
  if (!valid) throw new Error("El marcador de readiness del CRM está incompleto o es inválido.");
  return marker;
};

export const validateReadinessMarker = async (directory, marker) => {
  const [packageJson, packageLock, environment] = await Promise.all([
    readFile(resolve(directory, "package.json"), "utf8"),
    readFile(resolve(directory, "package-lock.json"), "utf8"),
    readFile(resolve(directory, ".env.local"), "utf8"),
  ]);
  JSON.parse(packageJson);
  JSON.parse(packageLock);
  const environmentFingerprint = fingerprintPublicEnvironment(environment);
  if (
    environmentFingerprint !== marker.environmentFingerprint
    || sha256(`${marker.sourceFingerprint}:${marker.environmentFingerprint}`) !== marker.fingerprint
  ) {
    throw new Error("El marcador de readiness no coincide con el contenido actual del CRM.");
  }
  return marker;
};

export const inspectCurrentWorkspaceReadiness = async (directory) => {
  let markerContents;
  try {
    markerContents = await readFile(resolve(directory, READY_MARKER_NAME), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    return { status: "invalid" };
  }

  let marker;
  try {
    marker = parseReadinessMarker(markerContents);
  } catch {
    return { status: "invalid" };
  }

  let current;
  try {
    current = await computeReadinessMetadata(directory);
  } catch {
    return { status: "invalid" };
  }

  const currentMarkerMatches = marker.sourceRevision === current.sourceRevision
    && marker.sourceFingerprint === current.sourceFingerprint
    && marker.environmentFingerprint === current.environmentFingerprint
    && marker.fingerprint === current.fingerprint;

  return currentMarkerMatches
    ? { status: "ready", marker }
    : { status: "stale" };
};
