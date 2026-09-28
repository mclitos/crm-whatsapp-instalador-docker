import { spawn, execFileSync } from "node:child_process";

import { parseComposeServices } from "./check-workspace.mjs";

const RESULT_PREFIX = "CRM_UPDATE_RESULT=";
const HEALTH_POLL_MS = 10000;
const HEALTH_TIMEOUT_MS = 20 * 60 * 1000;

export class ActualizarError extends Error {
  constructor(message, action) {
    super(message);
    this.name = "ActualizarError";
    this.action = action;
  }
}

/** Ejecuta mostrando la salida y devolviendo lo que salió por stdout. */
export const defaultRunStreaming = (command, args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { ...options, shell: false, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.on("error", reject);
  child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
});

export const defaultRunCapture = (command, args, options) => execFileSync(command, args, {
  ...options,
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 240000,
});

export const defaultRunInherit = (command, args, options) => {
  execFileSync(command, args, { ...options, shell: false, stdio: "inherit" });
};

export const parseActualizarArguments = (argv) => {
  const options = { docker: false, sinPull: false, commit: null, aplicarMigraciones: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--docker") options.docker = true;
    else if (argument === "--sin-pull") options.sinPull = true;
    else if (argument === "--aplicar-migraciones") options.aplicarMigraciones = true;
    else if (argument === "--commit") {
      options.commit = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--commit=")) options.commit = argument.slice("--commit=".length);
    else {
      throw new ActualizarError(
        `Opción desconocida: ${argument}`,
        "Opciones válidas: --docker, --commit <hash>, --aplicar-migraciones y --sin-pull.",
      );
    }
  }
  return options;
};

export const parseUpdateResult = (stdout) => {
  const line = stdout.split(/\r?\n/u).reverse().find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try {
    const result = JSON.parse(line.slice(RESULT_PREFIX.length));
    return ["updated", "unchanged"].includes(result?.status) ? result : null;
  } catch {
    return null;
  }
};

const crmState = (output) => {
  const service = parseComposeServices(output).find((candidate) => candidate?.Service === "crm");
  if (!service) return "missing";
  if (service.State !== "running") return "stopped";
  if (service.Health === "healthy") return "healthy";
  if (service.Health === "unhealthy") return "unhealthy";
  return "starting";
};

export const waitForCrmHealth = async ({
  directory,
  runCapture = defaultRunCapture,
  sleep,
  log,
  pollMs = HEALTH_POLL_MS,
  timeoutMs = HEALTH_TIMEOUT_MS,
}) => {
  let waited = 0;
  let announced = -1;
  while (waited <= timeoutMs) {
    let state;
    try {
      state = crmState(runCapture("docker", ["compose", "ps", "--all", "--format", "json", "crm"], { cwd: directory }));
    } catch {
      state = "starting";
    }
    if (state === "healthy") return "healthy";
    if (state === "unhealthy" || state === "stopped" || state === "missing") return state;
    const minute = Math.floor(waited / 60000);
    if (minute !== announced) {
      announced = minute;
      log(`Esperando a que el CRM termine de compilar y arrancar (${minute} min)...`);
    }
    await sleep(pollMs);
    waited += pollMs;
  }
  return "timeout";
};

/**
 * Actualiza una instalación Docker: instalador al día, imagen reconstruida,
 * actualizador dentro del contenedor y reinicio del CRM solo si hubo cambio.
 */
export const runDockerUpdate = async ({
  directory,
  options,
  runCapture = defaultRunCapture,
  runInherit = defaultRunInherit,
  runStreaming = defaultRunStreaming,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  log = (line) => console.log(line),
  pollMs,
  timeoutMs,
}) => {
  const cwd = { cwd: directory };

  let dirty;
  try {
    dirty = runCapture("git", ["status", "--porcelain", "--untracked-files=no"], cwd).trim();
  } catch (error) {
    throw new ActualizarError(
      "No pude revisar el estado de git del instalador.",
      "Ejecutá el comando dentro de la carpeta del instalador clonado con git.",
    );
  }
  if (dirty) {
    throw new ActualizarError(
      "El instalador tiene cambios locales sin guardar. No actualicé nada.",
      "Guardá o descartá tus cambios (git status) y volvé a correr el comando, o usá --sin-pull.",
    );
  }

  if (!options.sinPull) {
    log("Actualizando el instalador (git pull --ff-only)...");
    try {
      runInherit("git", ["pull", "--ff-only"], cwd);
    } catch {
      throw new ActualizarError(
        "No pude traer la última versión del instalador (git pull --ff-only).",
        "Revisá tu conexión y que tu rama no tenga commits propios; también podés usar --sin-pull.",
      );
    }
  }

  log("Reconstruyendo la imagen de Docker...");
  try {
    runInherit("docker", ["compose", "build", "updater", "crm"], cwd);
  } catch {
    throw new ActualizarError(
      "No pude reconstruir la imagen de Docker.",
      "Revisá el mensaje de arriba y que Docker esté en marcha. El CRM sigue funcionando sin cambios.",
    );
  }

  // Extra arguments after the service name replace its whole compose `command`,
  // so the updater entrypoint must be repeated explicitly.
  const updaterArguments = [
    "compose", "--profile", "update", "run", "--rm", "-T", "updater",
    "node", "/app/scripts/container/update-crm.mjs",
  ];
  if (options.commit !== null) updaterArguments.push("--commit", options.commit);
  if (options.aplicarMigraciones) updaterArguments.push("--aplicar-migraciones");

  log("Buscando la versión del CRM...");
  const run = await runStreaming("docker", updaterArguments, cwd);
  if (run.code !== 0) {
    throw new ActualizarError(
      run.code === 2
        ? "La actualización se detuvo antes de tocar nada: hay migraciones pendientes."
        : "La actualización no terminó.",
      run.code === 2
        ? "Leé el detalle de arriba. Después de exportar un backup en Supabase, repetí el comando con --aplicar-migraciones."
        : "Leé el detalle de arriba. El CRM sigue funcionando con la versión que tenía.",
    );
  }
  const result = parseUpdateResult(run.stdout);
  if (!result) {
    throw new ActualizarError(
      "El actualizador terminó sin informar el resultado.",
      "Revisá con: npm run check. Si el CRM no responde, repetí el comando.",
    );
  }
  if (result.status === "unchanged") {
    log("Nada que reiniciar: el CRM ya estaba en esa versión.");
    return { status: "unchanged", ...result };
  }

  log("Reiniciando el CRM. Puede tardar unos minutos (unos 3): compila la versión nueva antes de responder.");
  try {
    runInherit("docker", ["compose", "up", "-d", "--force-recreate", "crm"], cwd);
  } catch {
    throw new ActualizarError(
      "El código se actualizó, pero no pude reiniciar el CRM.",
      "Corré: docker compose up -d --force-recreate crm",
    );
  }

  const health = await waitForCrmHealth({ directory, runCapture, sleep, log, pollMs, timeoutMs });
  if (health !== "healthy") {
    throw new ActualizarError(
      health === "timeout"
        ? "El CRM sigue arrancando después de 20 minutos."
        : "El CRM no quedó saludable después de actualizar.",
      "Mirá los logs: docker compose logs --tail 100 crm. Para volver atrás: "
        + `npm run actualizar -- --docker --commit ${result.previous}`,
    );
  }
  log(`CRM actualizado: ${result.previous.slice(0, 12)} -> ${result.current.slice(0, 12)}. Ya responde en http://127.0.0.1:3300`);
  return { status: "updated", health, ...result };
};
