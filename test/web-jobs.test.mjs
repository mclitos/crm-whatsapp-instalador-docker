import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { provisionSupabase } from "../scripts/lib/supabase-setup.mjs";
import { JobStore } from "../scripts/web/job-store.mjs";

const temporaryDirectories = [];

const loadJobsModule = async () => {
  try {
    return await import("../scripts/web/setup-job.mjs");
  } catch {
    return {};
  }
};

const createDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "crm-installer-jobs-"));
  temporaryDirectories.push(directory);
  return directory;
};

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for job state");
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

for (const retryRequestId of ["request-write-failed", "request-after-repair"]) {
  test(`failed creation persistence permits retry ${retryRequestId} without restart`, async () => {
    const directory = await createDirectory();
    let sequence = 0;
    const store = new JobStore({ directory, idGenerator: () => `job-${++sequence}` });
    await store.initialize();
    const file = join(directory, "setup-jobs.json");
    await mkdir(file);

    await assert.rejects(store.create({ requestId: "request-write-failed", mode: "existing" }));
    await rm(file, { recursive: true });
    assert.equal(await store.get("job-1"), null);
    const retry = await store.create({ requestId: retryRequestId, mode: "existing" });

    assert.equal(retry.created, true);
    assert.equal(retry.snapshot.id, "job-2");
    assert.equal(retry.snapshot.status, "queued");
    assert.equal(await store.get("job-1"), null);
    const restarted = new JobStore({ directory });
    await restarted.initialize();
    assert.equal(await restarted.get("job-1"), null);
    assert.equal((await restarted.get("job-2")).status, "interrupted");
  });
}

test("concurrent duplicate requests cannot observe a job whose creation failed to persist", async () => {
  const directory = await createDirectory();
  const store = new JobStore({ directory, idGenerator: () => "job-unwritten" });
  await store.initialize();
  const file = join(directory, "setup-jobs.json");
  await mkdir(file);
  const input = { requestId: "request-concurrent", mode: "existing" };

  const results = await Promise.allSettled([store.create(input), store.create(input)]);

  assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
  await rm(file, { recursive: true });
  assert.equal(await store.get("job-unwritten"), null);
  assert.equal((await store.create(input)).created, true);
});

for (const failures of [1, 2]) {
  test(`initial running-state write failure recovers after ${failures} storage errors`, async (t) => {
    const { createSetupJobService } = await loadJobsModule();
    const directory = await createDirectory();
    const original = JobStore.prototype.update;
    let attempts = 0;
    let setups = 0;
    let notifications = 0;
    let sequence = 0;
    t.mock.method(JobStore.prototype, "update", async function (...args) {
      if (++attempts <= failures) throw new Error("storage-detail-must-stay-private");
      return original.apply(this, args);
    });
    const service = await createSetupJobService({
      directory,
      idGenerator: () => `job-start-${++sequence}`,
      runSetup: async () => { setups += 1; },
      onSetupSucceeded: async () => { notifications += 1; },
    });
    const request = { requestId: "request-start", mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" };

    const started = await service.start(request);
    await waitFor(() => attempts > 0);
    const failed = await service.get(started.id);

    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "setup_failed");
    assert.equal(JSON.stringify(failed).includes("storage-detail"), false);
    assert.equal(setups, 0);
    assert.equal(notifications, 0);
    const repeated = await service.start(request);
    assert.equal(repeated.id, started.id);
    assert.equal(repeated.status, "failed");
    const retry = await service.start({ ...request, requestId: "request-start-retry" });
    await waitFor(async () => (await service.get(retry.id))?.status === "succeeded");
    assert.equal(setups, 1);
    assert.equal(notifications, 1);
  });
}

test("a rejected update preserves the last durable snapshot and later writes recover", async () => {
  const directory = await createDirectory();
  const store = new JobStore({ directory, idGenerator: () => "job-existing" });
  await store.initialize();
  await store.create({ requestId: "request-existing", mode: "existing" });
  const previous = await store.update("job-existing", { status: "succeeded", stage: "completed" });
  const file = join(directory, "setup-jobs.json");
  const backup = join(directory, "saved-jobs.json");
  await rename(file, backup);
  await mkdir(file);

  await assert.rejects(store.update("job-existing", { status: "running", stage: "validating_account" }));
  assert.deepEqual(await store.get("job-existing"), previous);
  await rm(file, { recursive: true });
  await rename(backup, file);
  const restarted = new JobStore({ directory });
  await restarted.initialize();
  assert.deepEqual(await restarted.get("job-existing"), previous);
  const updated = await store.update("job-existing", { status: "failed", stage: "failed" });
  assert.equal(updated.status, "failed");
  assert.deepEqual(await store.get("job-existing"), updated);
});

test("persistent startup storage failures block new work until a start request can recover", async (t) => {
  const { createSetupJobService } = await loadJobsModule();
  const directory = await createDirectory();
  const original = JobStore.prototype.update;
  let unavailable = true;
  let attempts = 0;
  let setups = 0;
  let notifications = 0;
  let sequence = 0;
  t.mock.method(JobStore.prototype, "update", async function (...args) {
    attempts += 1;
    if (unavailable) throw new Error("storage unavailable");
    return original.apply(this, args);
  });
  const service = await createSetupJobService({
    directory,
    idGenerator: () => `job-persistent-${++sequence}`,
    runSetup: async () => { setups += 1; },
    onSetupSucceeded: async () => { notifications += 1; },
  });
  const request = { requestId: "request-persistent", mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" };
  const started = await service.start(request);
  await waitFor(() => attempts >= 2);
  await assert.rejects(service.get(started.id));
  await assert.rejects(service.start({ ...request, requestId: "request-still-unavailable" }));
  assert.equal(setups, 0);
  assert.equal(notifications, 0);
  assert.equal(sequence, 1);

  unavailable = false;
  const retry = await service.start({ ...request, requestId: "request-storage-restored" });
  assert.equal((await service.get(started.id)).status, "failed");
  await waitFor(async () => (await service.get(retry.id))?.status === "succeeded");
  assert.equal(setups, 1);
  assert.equal(notifications, 1);
});

test("job reads wait until the published state is durable", async () => {
  const directory = await createDirectory();
  const store = new JobStore({ directory, idGenerator: () => "job-durable" });
  await store.initialize();
  await store.create({ requestId: "request-durable", mode: "existing" });
  const update = store.update("job-durable", {
    status: "running",
    stage: "storing_project_ref",
  });

  const snapshot = await store.get("job-durable");
  const persisted = JSON.parse(await readFile(join(directory, "setup-jobs.json"), "utf8"));

  assert.equal(snapshot.stage, "storing_project_ref");
  assert.equal(persisted.jobs[0].stage, "storing_project_ref");
  await update;
});

test("a repeated requestId returns the same durable job and a second active request conflicts", async () => {
  const { createSetupJobService, JobConflictError } = await loadJobsModule();
  assert.equal(typeof createSetupJobService, "function");
  const directory = await createDirectory();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = await createSetupJobService({
    directory,
    runSetup: async () => blocked,
    idGenerator: () => "job-one",
  });
  const request = { requestId: "request-one", mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" };

  const first = await service.start(request);
  const repeated = await service.start(request);
  assert.equal(repeated.id, first.id);
  await assert.rejects(
    service.start({ ...request, requestId: "request-two" }),
    (error) => error instanceof JobConflictError && error.statusCode === 409,
  );
  release({ ref: request.ref });
  await waitFor(async () => (await service.get(first.id))?.status === "succeeded");
});

test("job snapshots are atomic, allowlisted, and secret-free", async () => {
  const { createSetupJobService } = await loadJobsModule();
  assert.equal(typeof createSetupJobService, "function");
  const directory = await createDirectory();
  const secret = "service-role-never-persisted";
  const service = await createSetupJobService({
    directory,
    idGenerator: () => "job-safe",
    async runSetup(_input, { onProgress }) {
      await onProgress({ stage: "fetching_keys", message: secret });
      return { ref: "abcdefghijklmnopqrst", leaked: secret };
    },
  });

  const started = await service.start({
    requestId: "request-safe",
    mode: "existing",
    ref: "abcdefghijklmnopqrst",
    publicUrl: "http://localhost:3000",
    unexpectedSecret: secret,
  });
  const finished = await waitFor(async () => {
    const job = await service.get(started.id);
    return job?.status === "succeeded" ? job : null;
  });
  const persisted = await readFile(join(directory, "setup-jobs.json"), "utf8");
  const serialized = JSON.stringify(finished);
  assert.equal(serialized.includes(secret), false);
  assert.equal(persisted.includes(secret), false);
  assert.deepEqual(Object.keys(finished).sort(), [
    "createdAt", "error", "id", "progress", "stage", "status", "statusUrl", "updatedAt",
  ]);
});

test("successful setup notifies once after the success snapshot is durable", async () => {
  const { createSetupJobService } = await loadJobsModule();
  const directory = await createDirectory();
  let notifications = 0;
  let durableStatus;
  const service = await createSetupJobService({
    directory,
    idGenerator: () => "job-handoff",
    runSetup: async () => ({}),
    async onSetupSucceeded() {
      const persisted = JSON.parse(await readFile(join(directory, "setup-jobs.json"), "utf8"));
      durableStatus = persisted.jobs[0].status;
      notifications += 1;
      throw new Error("handoff callback failed after persistence");
    },
  });
  const request = {
    requestId: "request-handoff",
    mode: "existing",
    ref: "abcdefghijklmnopqrst",
    publicUrl: "http://localhost:3300",
  };

  const started = await service.start(request);
  await service.start(request);
  const finished = await waitFor(async () => {
    const job = await service.get(started.id);
    return job?.status === "succeeded" && notifications === 1 ? job : null;
  });

  assert.equal(durableStatus, "succeeded");
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.error, null);
  assert.equal(notifications, 1);
});

test("restart marks stale active jobs interrupted and ambiguous creates need attention", async () => {
  const { createSetupJobService } = await loadJobsModule();
  assert.equal(typeof createSetupJobService, "function");
  const interruptedDirectory = await createDirectory();
  const never = new Promise(() => {});
  const first = await createSetupJobService({
    directory: interruptedDirectory,
    idGenerator: () => "job-interrupted",
    runSetup: async () => never,
  });
  await first.start({ requestId: "request-interrupted", mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000" });
  await waitFor(async () => (await first.get("job-interrupted"))?.status === "running");

  const restarted = await createSetupJobService({ directory: interruptedDirectory, runSetup: async () => ({}) });
  assert.equal((await restarted.get("job-interrupted")).status, "interrupted");

  const refPendingDirectory = await createDirectory();
  const refPending = await createSetupJobService({
    directory: refPendingDirectory,
    idGenerator: () => "job-ref-pending",
    async runSetup(_input, { onProgress }) {
      await onProgress({ stage: "storing_project_ref" });
      return never;
    },
  });
  await refPending.start({ requestId: "request-ref-pending", mode: "create", organizationSlug: "team", name: "CRM", region: "sa-east-1", publicUrl: "http://localhost:3000" });
  await waitFor(async () => (await refPending.get("job-ref-pending"))?.stage === "storing_project_ref");
  const refPendingRestarted = await createSetupJobService({ directory: refPendingDirectory, runSetup: async () => ({}) });
  assert.equal((await refPendingRestarted.get("job-ref-pending")).status, "needs_attention");

  const attentionDirectory = await createDirectory();
  const attention = await createSetupJobService({
    directory: attentionDirectory,
    idGenerator: () => "job-attention",
    async runSetup(_input, { onProgress }) {
      await onProgress({ stage: "creating_project" });
      const error = new Error("network outcome contains hidden details");
      error.code = "PROJECT_CREATION_AMBIGUOUS";
      throw error;
    },
  });
  await attention.start({ requestId: "request-attention", mode: "create", organizationSlug: "team", name: "CRM", region: "sa-east-1", publicUrl: "http://localhost:3000" });
  const needsAttention = await waitFor(async () => {
    const job = await attention.get("job-attention");
    return job?.status === "needs_attention" ? job : null;
  });
  assert.match(needsAttention.error.message, /Supabase|proyecto/u);
  assert.equal(JSON.stringify(needsAttention).includes("hidden details"), false);
  await assert.rejects(
    attention.start({ requestId: "request-duplicate-create", mode: "create", organizationSlug: "team", name: "CRM again", region: "sa-east-1", publicUrl: "http://localhost:3000" }),
    (error) => error.statusCode === 409,
  );
});

test("HTTP 500 during project creation needs attention and blocks another create request", async () => {
  const { createSetupJobService } = await loadJobsModule();
  assert.equal(typeof createSetupJobService, "function");
  const directory = await createDirectory();
  const upstreamDetail = "upstream detail must not persist";
  const service = await createSetupJobService({
    directory,
    idGenerator: () => "job-http-500",
    runSetup: (input, { onProgress }) => provisionSupabase(input, {
      admin: {
        organizaciones: async () => ({ ok: true, json: [{ slug: "team", name: "Team" }] }),
        crearProyecto: async () => ({ ok: false, status: 500, error: upstreamDetail }),
      },
      credentialStore: { update: async () => {} },
      workspace: {
        clearReady: async () => {},
        ensure: async () => { throw new Error("workspace must not be touched after readiness invalidation"); },
      },
      generateDbPassword: () => "database-password-secret",
      onProgress,
    }),
  });

  await service.start({
    requestId: "request-http-500",
    mode: "create",
    organizationSlug: "team",
    name: "CRM",
    region: "sa-east-1",
    publicUrl: "http://localhost:3000",
  });
  const needsAttention = await waitFor(async () => {
    const job = await service.get("job-http-500");
    return ["failed", "needs_attention"].includes(job?.status) ? job : null;
  });

  assert.equal(needsAttention.status, "needs_attention");
  assert.equal(JSON.stringify(needsAttention).includes(upstreamDetail), false);
  assert.equal((await readFile(join(directory, "setup-jobs.json"), "utf8")).includes(upstreamDetail), false);
  await assert.rejects(
    service.start({
      requestId: "request-http-500-retry",
      mode: "create",
      organizationSlug: "team",
      name: "CRM retry",
      region: "sa-east-1",
      publicUrl: "http://localhost:3000",
    }),
    (error) => error.statusCode === 409,
  );
});
