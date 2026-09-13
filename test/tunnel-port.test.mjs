import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveTunnelPort } from "../scripts/lib/tunnel-port.mjs";

test("explicit PORT wins without inspecting Docker", () => {
  let inspected = false;
  const port = resolveTunnelPort({
    environment: { PORT: "4567" },
    runCommand() { inspected = true; },
  });

  assert.equal(port, "4567");
  assert.equal(inspected, false);
});

test("Docker host port 3300 is selected deterministically for the running CRM service", () => {
  const port = resolveTunnelPort({
    environment: {},
    runCommand(command, args) {
      assert.equal(command, "docker");
      assert.deepEqual(args, ["compose", "ps", "--format", "json", "crm"]);
      return JSON.stringify({
        Service: "crm",
        State: "running",
        Health: "healthy",
        Publishers: [{ TargetPort: 3000, PublishedPort: 3300 }],
      });
    },
  });

  assert.equal(port, "3300");
});

test("Node port 3000 remains the fallback when Docker is absent or not serving the CRM", () => {
  assert.equal(resolveTunnelPort({ environment: {}, runCommand() { throw new Error("no Docker"); } }), "3000");
  assert.equal(resolveTunnelPort({
    environment: {},
    runCommand() {
      return JSON.stringify({
        Service: "crm",
        State: "running",
        Health: "healthy",
        Publishers: [{ TargetPort: 3000, PublishedPort: 4400 }],
      });
    },
  }), "3000");
});
