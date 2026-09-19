import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inspectCrmWorkspace,
  reportCrmWorkspace,
  REQUIRED_CRM_ENV_KEYS,
} from "../scripts/lib/check-workspace.mjs";

const completeEnvironment = Object.fromEntries(REQUIRED_CRM_ENV_KEYS.map((key) => [key, "configured"]));
completeEnvironment.ENCRYPTION_KEY = "a".repeat(64);

const captureReport = (workspace) => {
  const messages = { failures: [], successes: [], warnings: [] };
  reportCrmWorkspace(workspace, {
    fail(message) { messages.failures.push(message); },
    mask() { return "masked"; },
    ok(message) { messages.successes.push(message); },
    warn(message) { messages.warnings.push(message); },
  });
  return messages;
};

test("healthy Docker volume workspace replaces host-only file diagnostics", () => {
  const calls = [];
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(command, args) {
      calls.push({ command, args });
      if (args[1] === "ps") {
        return `${JSON.stringify({ Service: "crm", State: "running", Health: "healthy" })}\n`;
      }
      return JSON.stringify({
        checkout: true,
        environmentFile: true,
        configuredVariables: REQUIRED_CRM_ENV_KEYS,
        encryptionKeyValid: true,
      });
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "docker");
  assert.deepEqual(report.failures, []);
  assert.equal(report.successes.some((message) => message.includes("volumen Docker")), true);
  assert.equal(report.successes.some((message) => message === "./crm clonado"), false);
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 3)), [
    ["compose", "ps", "--all"],
    ["compose", "exec", "-T"],
  ]);
});

test("local checkout remains authoritative without invoking Docker", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: (path) => [
      "/installer/crm",
      "/installer/crm/.env.local",
      "/installer/crm/.git",
      "/installer/crm/supabase/migrations",
    ].includes(path),
    readEnvironment: () => completeEnvironment,
    runCommand() {
      throw new Error("Docker must not be inspected for a complete local checkout");
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "local");
  assert.deepEqual(report.failures, []);
  assert.equal(report.successes.includes("./crm clonado"), true);
  assert.equal(report.successes.includes("crm/.env.local existe"), true);
});

test("incomplete local directory with an environment defers to a valid Docker checkout", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: (path) => ["/installer/crm", "/installer/crm/.env.local"].includes(path),
    readEnvironment: () => completeEnvironment,
    runCommand(_command, args) {
      if (args[1] === "ps") {
        return JSON.stringify({ Service: "crm", State: "running", Health: "healthy" });
      }
      return JSON.stringify({
        checkout: true,
        environmentFile: true,
        configuredVariables: REQUIRED_CRM_ENV_KEYS,
        encryptionKeyValid: true,
      });
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "docker");
  assert.deepEqual(report.failures, []);
  assert.equal(report.successes.some((message) => message.includes("volumen Docker")), true);
});

test("complete local checkout without an environment stays authoritative", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: (path) => [
      "/installer/crm",
      "/installer/crm/.git",
      "/installer/crm/supabase/migrations",
    ].includes(path),
    readEnvironment: () => {
      throw new Error("A missing environment must not be read");
    },
    runCommand() {
      throw new Error("Docker must not replace a complete local checkout");
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "local");
  assert.equal(report.successes.includes("./crm clonado"), true);
  assert.equal(report.failures.includes("crm/.env.local no existe"), true);
});

test("missing local and Docker workspaces keep actionable failures", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand() {
      throw new Error("Docker unavailable");
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "missing");
  assert.equal(report.failures.includes("./crm no existe"), true);
  assert.equal(report.failures.includes("crm/.env.local no existe"), true);
  assert.equal(
    report.failures.includes("NEXT_PUBLIC_SUPABASE_URL vacía en crm/.env.local"),
    true,
  );
  assert.equal(report.warnings.includes("No pude revisar el workspace Docker"), true);
});

test("Docker workspace still reports genuinely missing configuration", () => {
  const configuredVariables = REQUIRED_CRM_ENV_KEYS.filter((key) => key !== "META_APP_SECRET");
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(_command, args) {
      if (args[1] === "ps") {
        return JSON.stringify({ Service: "crm", State: "running", Health: "healthy" });
      }
      return JSON.stringify({
        checkout: true,
        environmentFile: true,
        configuredVariables,
        encryptionKeyValid: true,
      });
    },
  });
  const report = captureReport(workspace);

  assert.deepEqual(report.failures, ["META_APP_SECRET vacía en .env.local del volumen Docker"]);
});

test("a stopped CRM container keeps its Docker workspace instead of reporting it missing", () => {
  const calls = [];
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(command, args) {
      calls.push({ command, args });
      if (args[1] === "ps") {
        return JSON.stringify({
          Service: "crm",
          State: "exited",
          Health: "",
          ExitCode: 137,
        });
      }
      if (args[1] === "exec") throw new Error("A stopped container cannot be executed into");
      return JSON.stringify({
        checkout: true,
        environmentFile: true,
        configuredVariables: REQUIRED_CRM_ENV_KEYS,
        encryptionKeyValid: true,
      });
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "docker");
  assert.equal(workspace.containerState, "stopped");
  assert.deepEqual(report.failures, []);
  assert.equal(report.warnings.includes("El CRM está apagado"), true);
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 4)), [
    ["compose", "ps", "--all", "--format"],
    ["compose", "run", "--rm", "--no-deps"],
  ]);
});

test("a stopped CRM container never suggests re-running the credential steps", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(_command, args) {
      if (args[1] === "ps") {
        return JSON.stringify({ Service: "crm", State: "exited", Health: "" });
      }
      return JSON.stringify({
        checkout: true,
        environmentFile: true,
        configuredVariables: REQUIRED_CRM_ENV_KEYS,
        encryptionKeyValid: true,
      });
    },
  });
  const actions = [];
  reportCrmWorkspace(workspace, {
    fail(message, action) { actions.push(action); },
    mask() { return "masked"; },
    ok() {},
    warn(message, action) { actions.push(action); },
  });

  assert.equal(actions.some((action) => action?.includes("paso1")), false);
  assert.equal(actions.some((action) => action?.includes("reconfigure")), false);
  assert.equal(actions.includes("corré: npm run levantar -- --docker"), true);
});

test("a stopped container over an emptied volume still fails", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(_command, args) {
      if (args[1] === "ps") {
        return JSON.stringify({ Service: "crm", State: "exited", Health: "" });
      }
      return JSON.stringify({
        checkout: false,
        environmentFile: false,
        configuredVariables: [],
        encryptionKeyValid: null,
      });
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "missing");
  assert.equal(report.failures.includes("./crm no existe"), true);
  assert.equal(report.warnings.includes("El volumen Docker del CRM está incompleto"), true);
});

test("an unreadable volume on a stopped container does not fabricate a workspace", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(_command, args) {
      if (args[1] === "ps") {
        return JSON.stringify({ Service: "crm", State: "exited", Health: "" });
      }
      throw new Error("volume unreadable");
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "missing");
  assert.equal(
    report.warnings.includes("No pude revisar los archivos del volumen Docker"),
    true,
  );
});

test("a running but unhealthy container is diagnosed as unhealthy, never as powered off", () => {
  const calls = [];
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(command, args) {
      calls.push({ command, args });
      if (args[1] === "ps") {
        return JSON.stringify({ Service: "crm", State: "running", Health: "unhealthy" });
      }
      if (args[1] === "run") throw new Error("A live volume must not get a second container");
      return JSON.stringify({
        checkout: true,
        environmentFile: true,
        configuredVariables: REQUIRED_CRM_ENV_KEYS,
        encryptionKeyValid: true,
      });
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "docker");
  assert.equal(workspace.containerState, "unhealthy");
  assert.deepEqual(report.failures, []);
  assert.equal(report.warnings.includes("El servicio Docker crm no está saludable"), true);
  assert.equal(report.warnings.includes("El CRM está apagado"), false);
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 2)), [
    ["compose", "ps"],
    ["compose", "exec"],
  ]);
});

test("the offline probe survives entrypoint output preceding its JSON", () => {
  const workspace = inspectCrmWorkspace({
    crmDirectory: "/installer/crm",
    directory: "/installer",
    exists: () => false,
    readEnvironment: () => ({}),
    runCommand(_command, args) {
      if (args[1] === "ps") {
        return JSON.stringify({ Service: "crm", State: "exited", Health: "" });
      }
      return [
        "CRM: dependencias y build vigentes; se reutilizan.",
        JSON.stringify({
          checkout: true,
          environmentFile: true,
          configuredVariables: REQUIRED_CRM_ENV_KEYS,
          encryptionKeyValid: true,
        }),
        "",
      ].join("\n");
    },
  });
  const report = captureReport(workspace);

  assert.equal(workspace.mode, "docker");
  assert.equal(workspace.containerState, "stopped");
  assert.deepEqual(report.failures, []);
});
