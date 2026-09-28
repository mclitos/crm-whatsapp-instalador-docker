import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ActualizarError,
  parseActualizarArguments,
  parseUpdateResult,
  runDockerUpdate,
} from "../scripts/lib/actualizar-docker.mjs";

const PREVIOUS = "a".repeat(40);
const CURRENT = "b".repeat(40);
const resultLine = (status) => `CRM_UPDATE_RESULT=${JSON.stringify({ status, previous: PREVIOUS, current: CURRENT })}\n`;

const createHarness = ({
  dirty = "",
  updaterCode = 0,
  updaterStdout = resultLine("updated"),
  healthStates = ["healthy"],
  failing = null,
} = {}) => {
  const commands = [];
  const logs = [];
  const states = [...healthStates];
  const run = (options = {}) => runDockerUpdate({
    directory: "/installer",
    options: { docker: true, sinPull: false, commit: null, aplicarMigraciones: false, ...options },
    runCapture(command, args) {
      commands.push([command, ...args]);
      if (command === "git") return dirty;
      const state = states.length > 1 ? states.shift() : states[0];
      return `${JSON.stringify({
        Service: "crm",
        State: state === "stopped" ? "exited" : "running",
        Health: state === "starting" ? "starting" : state,
      })}\n`;
    },
    runInherit(command, args) {
      commands.push([command, ...args]);
      if (failing && [command, ...args].join(" ").startsWith(failing)) throw new Error("boom");
    },
    async runStreaming(command, args) {
      commands.push([command, ...args]);
      return { code: updaterCode, stdout: updaterStdout };
    },
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  const has = (prefix) => commands.some((command) => command.join(" ").startsWith(prefix));
  return { run, commands, logs, has };
};

const rejectsAlreadyExplained = async (promise, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ActualizarError);
    assert.match(error.message, pattern);
    assert.ok(error.action.length > 0);
    return true;
  });
};

test("a dirty installer tree stops before pulling, building, or touching Docker", async () => {
  const harness = createHarness({ dirty: " M compose.yaml\n" });

  await rejectsAlreadyExplained(harness.run(), /cambios locales/u);
  assert.equal(harness.has("git pull"), false);
  assert.equal(harness.has("docker"), false);
});

test("the full update pulls, builds, runs the updater, restarts the CRM, and waits for health", async () => {
  const harness = createHarness({ healthStates: ["starting", "starting", "healthy"] });
  const result = await harness.run();

  assert.equal(result.status, "updated");
  const order = harness.commands.map((command) => command.slice(0, 5).join(" "));
  assert.deepEqual(order.filter((line) => !line.startsWith("docker compose ps")), [
    "git status --porcelain --untracked-files=no",
    "git pull --ff-only",
    "docker compose build updater crm",
    "docker compose --profile update run",
    "docker compose up -d --force-recreate",
  ]);
  assert.equal(order.filter((line) => line.startsWith("docker compose ps")).length, 3);
  assert.match(harness.logs.join("\n"), /unos minutos/u);
});

test("--sin-pull skips git pull and the flags are forwarded to the updater", async () => {
  const harness = createHarness();
  await harness.run({ sinPull: true, commit: CURRENT, aplicarMigraciones: true });

  assert.equal(harness.has("git pull"), false);
  const updater = harness.commands.find((command) => command.includes("updater") && command.includes("run"));
  assert.deepEqual(updater.slice(-4), ["updater", "--commit", CURRENT, "--aplicar-migraciones"]);
});

test("an unchanged version does not restart the CRM", async () => {
  const harness = createHarness({ updaterStdout: resultLine("unchanged") });
  const result = await harness.run();

  assert.equal(result.status, "unchanged");
  assert.equal(harness.has("docker compose up"), false);
});

test("pending migrations exit code 2 explains the confirmation flow and does not restart", async () => {
  const harness = createHarness({ updaterCode: 2, updaterStdout: "" });

  await assert.rejects(harness.run(), (error) => {
    assert.match(error.message, /migraciones pendientes/u);
    assert.match(error.action, /--aplicar-migraciones/u);
    return true;
  });
  assert.equal(harness.has("docker compose up"), false);
});

test("an unhealthy CRM after the restart reports the way back", async () => {
  const harness = createHarness({ healthStates: ["unhealthy"] });

  await assert.rejects(harness.run(), (error) => {
    assert.match(error.message, /no quedó saludable/u);
    assert.match(error.action, new RegExp(`--commit ${PREVIOUS}`, "u"));
    return true;
  });
});

test("a failed build stops before running the updater", async () => {
  const harness = createHarness({ failing: "docker compose build" });

  await rejectsAlreadyExplained(harness.run(), /reconstruir la imagen/u);
  assert.equal(harness.has("docker compose --profile update"), false);
});

test("arguments and the updater result line are parsed strictly", () => {
  assert.deepEqual(
    parseActualizarArguments(["--docker", "--sin-pull", "--commit", CURRENT, "--aplicar-migraciones"]),
    { docker: true, sinPull: true, commit: CURRENT, aplicarMigraciones: true },
  );
  assert.throws(() => parseActualizarArguments(["--borrar"]), ActualizarError);
  assert.equal(parseUpdateResult("ruido\n"), null);
  assert.equal(parseUpdateResult(`x\n${resultLine("unchanged")}`).status, "unchanged");
  assert.equal(parseUpdateResult("CRM_UPDATE_RESULT={mal"), null);
});
