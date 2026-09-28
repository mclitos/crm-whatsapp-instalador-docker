import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "crm-version.json");
const FULL_COMMIT = /^[a-f0-9]{40}$/u;

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

export const isFullCommit = (value) => typeof value === "string" && FULL_COMMIT.test(value);

/** Lee la versión revisada del CRM (crm-version.json, versionado en este repo). */
export const readPinnedCrmVersion = (path = VERSION_FILE) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      "No pude leer crm-version.json. Restaurá el archivo con `git checkout crm-version.json`.",
      { cause: error },
    );
  }
  if (!nonEmpty(parsed?.repo) || !isFullCommit(parsed?.commit)) {
    throw new Error(
      "crm-version.json es inválido: necesita `repo` y un `commit` completo de 40 caracteres.",
    );
  }
  return { repoUrl: parsed.repo.trim(), commit: parsed.commit };
};

/**
 * Un CRM_REPO_URL explícito (entorno o credenciales) gana y sigue la rama por
 * defecto de ese repositorio (`commit: null`). Sin él se usa la versión fijada.
 */
export const resolveCrmSource = ({
  environment = process.env,
  credentials = {},
  pinned = readPinnedCrmVersion,
} = {}) => {
  if (nonEmpty(environment.CRM_REPO_URL)) return { repoUrl: environment.CRM_REPO_URL.trim(), commit: null };
  if (nonEmpty(credentials.CRM_REPO_URL)) return { repoUrl: credentials.CRM_REPO_URL.trim(), commit: null };
  return pinned();
};

export const resolveCrmRepoUrl = (options = {}) => resolveCrmSource(options).repoUrl;
