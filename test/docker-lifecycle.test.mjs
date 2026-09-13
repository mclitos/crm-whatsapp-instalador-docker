import assert from "node:assert/strict";
import { test } from "node:test";

import { runDockerLifecycle } from "../scripts/lib/docker-lifecycle.mjs";

test("Docker lifecycle stops old services, runs the one-shot installer, then starts only CRM", () => {
  const calls = [];
  runDockerLifecycle({
    directory: "/installer",
    runCommand(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
    },
  });

  assert.deepEqual(calls, [
    { command: "docker", args: ["compose", "stop", "installer", "crm"], cwd: "/installer" },
    { command: "docker", args: ["compose", "run", "--build", "--service-ports", "--rm", "installer"], cwd: "/installer" },
    { command: "docker", args: ["compose", "up", "--build", "-d", "crm"], cwd: "/installer" },
  ]);
});

test("Docker lifecycle never starts CRM when the installer command fails", () => {
  const calls = [];
  assert.throws(() => runDockerLifecycle({
    directory: "/installer",
    runCommand(_command, args) {
      calls.push(args);
      if (args[1] === "run") throw new Error("installer failed");
    },
  }), /installer failed/u);

  assert.deepEqual(calls.map((args) => args[1]), ["stop", "run"]);
});

test("Docker reconfiguration explicitly bypasses only the readiness fast path", () => {
  const calls = [];
  runDockerLifecycle({
    directory: "/installer",
    forceSetup: true,
    runCommand(_command, args) { calls.push(args); },
  });

  assert.deepEqual(calls[1], [
    "compose", "run", "--build", "--service-ports", "--rm",
    "-e", "CRM_FORCE_SETUP=1", "installer",
  ]);
});
