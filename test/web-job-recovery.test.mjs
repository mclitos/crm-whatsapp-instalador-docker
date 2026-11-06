import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { JobStore } from "../scripts/web/job-store.mjs";
import { createSetupJobService } from "../scripts/web/setup-job.mjs";

const directories = [];
const createDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "crm-recovery-"));
  directories.push(directory);
  return directory;
};
const ambiguous = async (directory, id = "ambiguous") => {
  let sequence = 0;
  const store = new JobStore({ directory, idGenerator: () => sequence++ === 0 ? id : `${id}-${sequence}` });
  await store.initialize();
  const created = await store.create({
    requestId: `request-${id}`, mode: id === "second" ? "existing" : "create", organizationSlug: "team", name: "CRM",
    region: "sa-east-1", publicUrl: "http://localhost:3000",
  });
  await store.update(id, { status: "needs_attention", stage: "needs_attention", error: {
    code: "project_creation_ambiguous",
    message: "Supabase pudo haber creado el proyecto. Revisá el panel antes de volver a intentar.",
  } });
  return { store, created: created.snapshot };
};
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i += 1) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for recovery job");
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("store lists only durable ambiguous jobs and resolves them once, preserving request identity", async () => {
  const directory = await createDirectory();
  const { store } = await ambiguous(directory);
  const attention = await store.listAttention();
  assert.deepEqual(attention.map((job) => job.id), ["ambiguous"]);
  assert.equal(JSON.stringify(attention).includes("request-ambiguous"), false);

  const resolution = { decision: "existing", ref: "abcdefghijklmnopqrst" };
  const resolved = await store.resolveAttention("ambiguous", resolution);
  assert.equal(resolved.status, "interrupted");
  assert.equal(resolved.stage, "interrupted");
  assert.equal(resolved.error.code, "interrupted");
  assert.deepEqual(resolved.resolution, resolution);
  const repeatedRequest = await store.create({ requestId: "request-ambiguous", mode: "create" });
  assert.equal(repeatedRequest.created, false);
  assert.deepEqual(repeatedRequest.snapshot, resolved);
  assert.deepEqual(await store.resolveAttention("ambiguous", resolution), resolved);
  assert.deepEqual(await store.listAttention(), []);

  const restarted = new JobStore({ directory });
  await restarted.initialize();
  assert.deepEqual((await restarted.get("ambiguous")).resolution, resolution);
  assert.deepEqual(await restarted.listAttention(), []);
});

test("service requires explicit confirmation, validates project access before durable resolution, and never provisions", async () => {
  const directory = await createDirectory();
  await ambiguous(directory);
  let validationCalls = 0;
  let setupCalls = 0;
  let notifications = 0;
  const service = await createSetupJobService({
    directory,
    validateRecoveryProject: async (ref) => {
      validationCalls += 1;
      assert.equal(ref, "abcdefghijklmnopqrst");
      return { ok: true };
    },
    runSetup: async () => { setupCalls += 1; },
    onSetupSucceeded: async () => { notifications += 1; },
  });

  const before = await service.get("ambiguous");
  for (const body of [
    { decision: "not_created" },
    { decision: "existing", confirmed: true },
    { decision: "not_created", confirmed: true, ref: "abcdefghijklmnopqrst" },
    { decision: "existing", confirmed: true, ref: "BAD" },
    null,
  ]) {
    await assert.rejects(service.resolve("ambiguous", body), (error) => error.statusCode === 400);
    assert.deepEqual(await service.get("ambiguous"), before);
  }
  assert.equal(validationCalls, 0);

  const body = { decision: "existing", confirmed: true, ref: "abcdefghijklmnopqrst" };
  const first = await service.resolve("ambiguous", body);
  assert.deepEqual(first.resolution, { decision: "existing", ref: body.ref });
  assert.deepEqual(await service.resolve("ambiguous", body), first);
  assert.equal(validationCalls, 1, "same decision retry skips external validation");
  await assert.rejects(service.resolve("ambiguous", { decision: "not_created", confirmed: true }),
    (error) => error.statusCode === 409);
  assert.equal(setupCalls, 0);
  assert.equal(notifications, 0);
});

test("existing-project validation failure is sanitized and leaves the ambiguity unresolved", async () => {
  const directory = await createDirectory();
  await ambiguous(directory);
  const service = await createSetupJobService({
    directory,
    validateRecoveryProject: async () => { throw new Error("token and upstream payload"); },
    runSetup: async () => assert.fail("must not provision during resolution"),
  });
  const before = await service.get("ambiguous");
  await assert.rejects(service.resolve("ambiguous", {
    decision: "existing", confirmed: true, ref: "abcdefghijklmnopqrst",
  }), (error) => error.statusCode === 502 && !error.publicMessage.includes("upstream payload"));
  assert.deepEqual(await service.get("ambiguous"), before);
  assert.equal((await service.listAttention()).length, 1);
});

test("not-created resolution unblocks explicit create; other ambiguous jobs still block creates", async () => {
  const directory = await createDirectory();
  await ambiguous(directory, "first");
  await ambiguous(directory, "second");
  const service = await createSetupJobService({ directory, runSetup: async () => {} });
  await assert.rejects(service.start({
    requestId: "new-create-before-resolution", mode: "create", organizationSlug: "team",
    name: "CRM", region: "sa-east-1", publicUrl: "http://localhost:3000",
  }), (error) => error.statusCode === 409);
  await service.resolve("first", { decision: "not_created", confirmed: true });
  await assert.rejects(service.start({
    requestId: "new-create-still-blocked", mode: "create", organizationSlug: "team",
    name: "CRM", region: "sa-east-1", publicUrl: "http://localhost:3000",
  }), (error) => error.statusCode === 409);
  await service.resolve("second", { decision: "not_created", confirmed: true });
  const started = await service.start({
    requestId: "new-create-after-resolution", mode: "create", organizationSlug: "team",
    name: "CRM", region: "sa-east-1", publicUrl: "http://localhost:3000",
  });
  assert.equal(started.status, "queued");
  await waitFor(async () => (await service.get(started.id))?.status === "succeeded");
});

test("unknown and non-ambiguous jobs cannot be resolved", async () => {
  const directory = await createDirectory();
  const { store } = await ambiguous(directory);
  const ordinary = await store.create({ requestId: "ordinary", mode: "existing" });
  const service = await createSetupJobService({ directory, runSetup: async () => {} });
  const body = { decision: "not_created", confirmed: true };
  await assert.rejects(service.resolve("missing", body), (error) => error.statusCode === 404);
  await assert.rejects(service.resolve(ordinary.snapshot.id, body), (error) => error.statusCode === 409);
});

test("ordinary jobs are rejected before checking external project access", async () => {
  const directory = await createDirectory();
  const store = new JobStore({ directory, idGenerator: () => "ordinary-job" });
  await store.initialize();
  await store.create({ requestId: "request-ordinary", mode: "existing" });
  let validations = 0;
  const service = await createSetupJobService({
    directory,
    validateRecoveryProject: async () => { validations += 1; return true; },
    runSetup: async () => assert.fail("must not provision during recovery"),
  });
  const previous = await service.get("ordinary-job");

  await assert.rejects(service.resolve("ordinary-job", {
    decision: "existing", ref: "abcdefghijklmnopqrst", confirmed: true,
  }), (error) => error.statusCode === 409);

  assert.equal(validations, 0);
  assert.deepEqual(await service.get("ordinary-job"), previous);
});

test("concurrent store resolutions accept only one decision and failed persistence publishes nothing", async () => {
  const directory = await createDirectory();
  const { store } = await ambiguous(directory);
  const outcomes = await Promise.allSettled([
    store.resolveAttention("ambiguous", { decision: "not_created" }),
    store.resolveAttention("ambiguous", { decision: "existing", ref: "abcdefghijklmnopqrst" }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);

  const secondDirectory = await createDirectory();
  const { store: failingStore } = await ambiguous(secondDirectory, "failure");
  const previous = await failingStore.get("failure");
  await rm(join(secondDirectory, "setup-jobs.json"));
  await mkdir(join(secondDirectory, "setup-jobs.json"));
  await assert.rejects(failingStore.resolveAttention("failure", { decision: "not_created" }));
  assert.deepEqual(await failingStore.get("failure"), previous);
  await rm(join(secondDirectory, "setup-jobs.json"), { recursive: true });
  const retried = await failingStore.resolveAttention("failure", { decision: "not_created" });
  assert.equal(retried.status, "interrupted");
});
