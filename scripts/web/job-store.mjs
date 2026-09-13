import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
export const JOB_STATUSES = new Set([
  ...ACTIVE_JOB_STATUSES,
  "succeeded",
  "failed",
  "interrupted",
  "needs_attention",
]);

const secureMode = async (path, mode) => {
  if (process.platform !== "win32") await chmod(path, mode);
};

const publicSnapshot = (job) => ({
  id: job.id,
  status: job.status,
  stage: job.stage,
  progress: { ...job.progress },
  error: job.error ? { ...job.error } : null,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  statusUrl: `/api/jobs/${job.id}`,
});

export class JobConflictError extends Error {
  constructor() {
    super("Ya hay una configuración de Supabase en curso.");
    this.name = "JobConflictError";
    this.statusCode = 409;
    this.publicMessage = this.message;
  }
}

export class JobStore {
  constructor({ directory, now = () => new Date(), idGenerator } = {}) {
    this.directory = resolve(directory);
    this.path = resolve(this.directory, "setup-jobs.json");
    this.now = now;
    this.idGenerator = idGenerator || (() => randomBytes(18).toString("base64url"));
    this.jobs = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await secureMode(this.directory, 0o700);
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.jobs = [];
    }

    let changed = false;
    for (const job of this.jobs) {
      if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
      const ambiguous = job.input?.mode === "create"
        && ["creating_project", "storing_project_ref"].includes(job.stage);
      job.status = ambiguous ? "needs_attention" : "interrupted";
      job.stage = ambiguous ? "needs_attention" : "interrupted";
      job.error = ambiguous
        ? {
            code: "project_creation_ambiguous",
            message: "Supabase pudo haber creado el proyecto. Revisá el panel antes de volver a intentar.",
          }
        : {
            code: "interrupted",
            message: "El instalador se reinició antes de terminar. Podés revisar el estado y volver a intentar.",
          };
      job.updatedAt = this.#timestamp();
      changed = true;
    }
    if (changed) await this.#persist();
  }

  async create(input) {
    const repeated = this.jobs.find((job) => job.requestId === input.requestId);
    if (repeated) return { snapshot: publicSnapshot(repeated), created: false };
    const unresolvedCreation = input.mode === "create" && this.jobs.some((job) => (
      job.status === "needs_attention" && job.error?.code === "project_creation_ambiguous"
    ));
    if (unresolvedCreation) throw new JobConflictError();
    if (this.jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))) throw new JobConflictError();

    const timestamp = this.#timestamp();
    const job = {
      id: this.idGenerator(),
      requestId: input.requestId,
      input: { ...input },
      status: "queued",
      stage: "queued",
      progress: { current: 0, total: 0, message: "Preparando la instalación." },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.push(job);
    await this.#persist();
    return { snapshot: publicSnapshot(job), created: true };
  }

  async get(id) {
    await this.writeQueue;
    const job = this.jobs.find((candidate) => candidate.id === id);
    return job ? publicSnapshot(job) : null;
  }

  getInternal(id) {
    return this.jobs.find((candidate) => candidate.id === id) || null;
  }

  async update(id, patch) {
    const job = this.getInternal(id);
    if (!job) return null;
    if (patch.status && JOB_STATUSES.has(patch.status)) job.status = patch.status;
    if (typeof patch.stage === "string") job.stage = patch.stage;
    if (patch.progress) job.progress = { ...patch.progress };
    if (Object.hasOwn(patch, "error")) job.error = patch.error ? { ...patch.error } : null;
    job.updatedAt = this.#timestamp();
    await this.#persist();
    return publicSnapshot(job);
  }

  #timestamp() {
    const value = this.now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  async #persist() {
    const operation = async () => {
      const temporaryPath = resolve(this.directory, `.setup-jobs.${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporaryPath, `${JSON.stringify({ version: 1, jobs: this.jobs }, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await secureMode(temporaryPath, 0o600);
        await rename(temporaryPath, this.path);
        await secureMode(this.path, 0o600);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    await this.writeQueue;
  }
}
