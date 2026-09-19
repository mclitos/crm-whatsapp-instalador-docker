import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const REQUIRED_CRM_ENV_KEYS = Object.freeze([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ENCRYPTION_KEY",
  "META_APP_SECRET",
]);

const dockerProbe = `
const fs = require("node:fs");
const directory = process.env.CRM_WORKSPACE_DIR || "/workspace/crm";
const environmentPath = directory + "/.env.local";
const requiredKeys = ${JSON.stringify(REQUIRED_CRM_ENV_KEYS)};
let environment = {};
if (fs.existsSync(environmentPath)) {
  for (const raw of fs.readFileSync(environmentPath, "utf8").split("\\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    environment[key] = value;
  }
}
console.log(JSON.stringify({
  checkout: fs.existsSync(directory + "/.git") && fs.existsSync(directory + "/supabase/migrations"),
  environmentFile: fs.existsSync(environmentPath),
  configuredVariables: requiredKeys.filter((key) => Boolean(environment[key])),
  encryptionKeyValid: environment.ENCRYPTION_KEY
    ? /^[a-f0-9]{64}$/i.test(environment.ENCRYPTION_KEY)
    : null,
}));
`;

const defaultRunCommand = (command, args, options) => execFileSync(command, args, {
  ...options,
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 240000,
});

const parseComposeServices = (output) => {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }
};

const readDockerProbe = (output) => {
  // `compose run` arranca el entrypoint de la imagen: cualquier línea suya
  // precede al JSON de la sonda, así que nos quedamos con la última.
  const lines = output.trim().split(/\r?\n/u).filter((line) => line.trim());
  const probe = JSON.parse(lines[lines.length - 1]);
  if (!probe?.checkout || !probe?.environmentFile) return null;
  return {
    configuredVariables: Array.isArray(probe.configuredVariables)
      ? probe.configuredVariables.filter((key) => REQUIRED_CRM_ENV_KEYS.includes(key))
      : [],
    encryptionKeyValid: probe.encryptionKeyValid === null
      ? null
      : probe.encryptionKeyValid === true,
  };
};

const incompleteVolume = {
  status: "invalid",
  message: "El volumen Docker del CRM está incompleto",
  action: "corré: npm run levantar -- --docker --reconfigure",
};

const unreadableVolume = {
  status: "invalid",
  message: "No pude revisar los archivos del volumen Docker",
  action: "revisá: docker compose ps y docker compose logs crm",
};

const inspectDockerWorkspace = ({ directory, runCommand }) => {
  let services;
  try {
    const output = runCommand(
      "docker",
      ["compose", "ps", "--all", "--format", "json", "crm"],
      { cwd: directory },
    );
    services = parseComposeServices(output);
  } catch {
    return {
      status: "unavailable",
      message: "No pude revisar el workspace Docker",
      action: "verificá que Docker esté disponible y que este directorio tenga el compose del CRM",
    };
  }

  // `--all` incluye contenedores detenidos: un CRM apagado sigue siendo una
  // instalación Docker válida, y sus archivos viven en el volumen, no acá.
  const service = services.find((candidate) => candidate?.Service === "crm");
  if (!service) {
    return {
      status: "unavailable",
      message: "El servicio Docker crm no está iniciado",
      action: "corré: npm run levantar -- --docker",
    };
  }

  // Un contenedor corriendo pero enfermo no está apagado: se sondea igual con
  // `exec` —no duplicamos un contenedor sobre un volumen en uso— y se reporta
  // con su propio diagnóstico en vez de confundirlo con uno detenido.
  const running = service.State === "running";
  const containerState = running
    ? (service.Health === "healthy" ? "healthy" : "unhealthy")
    : "stopped";
  try {
    // Con el contenedor vivo alcanza con `exec`. Detenido, montamos el mismo
    // volumen en un contenedor descartable: nunca inventamos un workspace
    // ausente solo porque el CRM no está corriendo.
    const output = running
      ? runCommand(
        "docker",
        ["compose", "exec", "-T", "crm", "node", "-e", dockerProbe],
        { cwd: directory },
      )
      : runCommand(
        "docker",
        ["compose", "run", "--rm", "--no-deps", "-T", "crm", "node", "-e", dockerProbe],
        { cwd: directory },
      );
    const probe = readDockerProbe(output);
    if (!probe) return incompleteVolume;
    return { status: "ready", containerState, ...probe };
  } catch {
    return unreadableVolume;
  }
};

export const inspectCrmWorkspace = ({
  crmDirectory,
  directory,
  exists = existsSync,
  readEnvironment,
  runCommand = defaultRunCommand,
}) => {
  const environmentPath = resolve(crmDirectory, ".env.local");
  const directoryExists = exists(crmDirectory);
  const checkoutExists = exists(resolve(crmDirectory, ".git"))
    && exists(resolve(crmDirectory, "supabase", "migrations"));
  const environmentFile = exists(environmentPath);
  const environment = environmentFile ? readEnvironment(environmentPath) : {};

  if (checkoutExists) {
    return {
      mode: "local",
      checkoutExists,
      directoryExists,
      environment,
      environmentFile,
      configuredVariables: REQUIRED_CRM_ENV_KEYS.filter((key) => Boolean(environment[key])),
      encryptionKeyValid: environment.ENCRYPTION_KEY
        ? /^[a-f0-9]{64}$/iu.test(environment.ENCRYPTION_KEY)
        : null,
    };
  }

  const docker = inspectDockerWorkspace({ directory, runCommand });
  if (docker.status === "ready") {
    return {
      mode: "docker",
      checkoutExists: true,
      containerState: docker.containerState || "healthy",
      environment: {},
      environmentFile: true,
      configuredVariables: docker.configuredVariables,
      encryptionKeyValid: docker.encryptionKeyValid,
    };
  }

  return {
    mode: "missing",
    checkoutExists,
    directoryExists,
    docker,
    environment,
    environmentFile,
    configuredVariables: REQUIRED_CRM_ENV_KEYS.filter((key) => Boolean(environment[key])),
    encryptionKeyValid: environment.ENCRYPTION_KEY
      ? /^[a-f0-9]{64}$/iu.test(environment.ENCRYPTION_KEY)
      : null,
  };
};

const CONTAINER_STATE_DETAIL = Object.freeze({
  healthy: "servicio crm saludable",
  stopped: "volumen intacto, contenedor apagado",
  unhealthy: "volumen intacto, servicio no saludable",
});

const CONTAINER_STATE_WARNING = Object.freeze({
  healthy: null,
  stopped: {
    message: "El CRM está apagado",
    action: "corré: npm run levantar -- --docker",
  },
  unhealthy: {
    message: "El servicio Docker crm no está saludable",
    action: "revisá: docker compose ps y docker compose logs crm",
  },
});

export const reportCrmWorkspace = (workspace, {
  fail,
  mask,
  ok,
  warn,
}) => {
  const configuredVariables = new Set(workspace.configuredVariables);
  if (workspace.mode === "docker") {
    ok("Workspace del CRM disponible en el volumen Docker", CONTAINER_STATE_DETAIL[workspace.containerState]);
    ok(".env.local existe en el volumen Docker");
    const containerWarning = CONTAINER_STATE_WARNING[workspace.containerState];
    if (containerWarning) warn(containerWarning.message, containerWarning.action);
  } else {
    if (workspace.checkoutExists) ok("./crm clonado");
    else if (workspace.directoryExists) {
      fail("./crm existe pero está incompleto", "corré: npm run paso1");
    } else fail("./crm no existe", "corré: npm run paso1");

    if (workspace.environmentFile) ok("crm/.env.local existe");
    else fail("crm/.env.local no existe", "corré: npm run paso1");

    if (workspace.docker) warn(workspace.docker.message, workspace.docker.action);
  }

  const environmentLabel = workspace.mode === "docker"
    ? ".env.local del volumen Docker"
    : "crm/.env.local";
  const missingAction = workspace.mode === "docker"
    ? "corré: npm run levantar -- --docker --reconfigure"
    : "corré: npm run paso1";

  for (const key of REQUIRED_CRM_ENV_KEYS) {
    if (configuredVariables.has(key)) {
      const value = workspace.environment[key];
      const detail = workspace.mode === "docker"
        ? "configurada en el volumen Docker"
        : key.includes("KEY") || key.includes("SECRET")
          ? mask(value)
          : value;
      ok(key, detail);
    } else {
      fail(`${key} vacía en ${environmentLabel}`, missingAction);
    }
  }

  if (workspace.encryptionKeyValid === false) {
    fail(
      "ENCRYPTION_KEY no son 64 caracteres hexadecimales",
      "tiene que ser exactamente 32 bytes en hex",
    );
  }
};
