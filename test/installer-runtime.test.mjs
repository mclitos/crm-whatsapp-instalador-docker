import assert from "node:assert/strict";
import { test } from "node:test";

import { runInstallerRuntime } from "../scripts/container/installer-runtime.mjs";

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for installer runtime state");
};

const createFakeServer = () => {
  let closeCalls = 0;
  return {
    address: () => ({ port: 7359 }),
    close(callback) {
      closeCalls += 1;
      callback();
    },
    get closeCalls() { return closeCalls; },
  };
};

test("installer fast-exits a current workspace without starting the web installer", async () => {
  let starts = 0;
  const result = await runInstallerRuntime({
    environment: {},
    inspectReadiness: async () => ({ status: "ready" }),
    logger: { info() {} },
    startInstaller: async () => { starts += 1; },
  });

  assert.deepEqual(result, { status: "already_ready" });
  assert.equal(starts, 0);
});

test("installer closes once only after durable success is observable", async () => {
  const server = createFakeServer();
  let callbacks;
  const running = runInstallerRuntime({
    environment: {},
    inspectReadiness: async () => ({ status: "missing" }),
    logger: { info() {} },
    startInstaller: async (options) => {
      callbacks = options;
      return server;
    },
  });
  await waitFor(() => callbacks);

  callbacks.onSuccessfulSetupObserved();
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(server.closeCalls, 0);

  callbacks.onSetupSucceeded();
  callbacks.onSuccessfulSetupObserved();
  callbacks.onSuccessfulSetupObserved();

  assert.deepEqual(await running, { status: "provisioned" });
  assert.equal(server.closeCalls, 1);
});

test("installer uses a bounded fallback after durable success when the browser disappears", async () => {
  const server = createFakeServer();
  let callbacks;
  let fallback;
  const running = runInstallerRuntime({
    environment: {},
    inspectReadiness: async () => ({ status: "stale" }),
    logger: { info() {} },
    schedule(callback) {
      fallback = callback;
      return 1;
    },
    cancelSchedule() {},
    startInstaller: async (options) => {
      callbacks = options;
      return server;
    },
  });
  await waitFor(() => callbacks);

  callbacks.onSetupSucceeded();
  assert.equal(typeof fallback, "function");
  fallback();

  assert.deepEqual(await running, { status: "provisioned" });
  assert.equal(server.closeCalls, 1);
});
