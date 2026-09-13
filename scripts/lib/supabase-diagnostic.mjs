import { execFileSync } from "node:child_process";

import { SupabaseAdmin } from "./supabase.mjs";

const CREDENTIAL_STATUSES = new Set(["missing", "ready", "unreadable"]);
const PROJECT_STATUSES = new Set(["healthy", "paused", "unavailable", "unhealthy"]);
const AUTH_STATUSES = new Set(["configured", "local", "missing", "unavailable"]);

const defaultRunCommand = (command, args, options) => execFileSync(command, args, {
  ...options,
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 240000,
});

const resultRows = (response) => (
  Array.isArray(response?.json) ? response.json : response?.json?.result || []
);

const unavailablePayload = (credentials = "unreadable") => ({
  version: 1,
  credentials,
  project: "unavailable",
  tables: { status: "unavailable", count: 0 },
  migrations: { status: "unavailable", count: 0 },
  auth: "unavailable",
});

export const collectSupabaseDiagnostic = async ({
  credentialStore,
  createAdmin = (token) => new SupabaseAdmin(token),
} = {}) => {
  let credentials;
  try {
    credentials = await credentialStore.load({ createKey: false });
  } catch {
    return unavailablePayload();
  }
  if (!credentials?.supabaseAccessToken || !credentials?.supabaseProjectRef) {
    return unavailablePayload("missing");
  }

  const payload = unavailablePayload("ready");
  let admin;
  try {
    admin = createAdmin(credentials.supabaseAccessToken);
    const project = await admin.proyecto(credentials.supabaseProjectRef);
    if (!project?.ok) return payload;
    const projectStatus = project.json?.status;
    payload.project = projectStatus === "ACTIVE_HEALTHY"
      ? "healthy"
      : projectStatus === "INACTIVE"
        ? "paused"
        : "unhealthy";

    const tables = await admin.sql(
      credentials.supabaseProjectRef,
      "select count(*)::int as n from information_schema.tables where table_schema='public';",
    );
    if (tables?.ok) {
      const count = Number(resultRows(tables)[0]?.n);
      const safeCount = Number.isInteger(count) && count >= 0 ? count : 0;
      payload.tables = { status: safeCount >= 20 ? "complete" : "incomplete", count: safeCount };
    }

    try {
      const migrations = await admin.migracionesAplicadas(credentials.supabaseProjectRef);
      const count = migrations instanceof Set ? migrations.size : 0;
      payload.migrations = { status: count > 0 ? "present" : "empty", count };
    } catch {
      // Keep the allowlisted unavailable status.
    }

    const auth = await admin.authConfig(credentials.supabaseProjectRef);
    if (auth?.ok) {
      const siteUrl = typeof auth.json?.site_url === "string" ? auth.json.site_url : "";
      if (!siteUrl) payload.auth = "missing";
      else {
        try {
          const hostname = new URL(siteUrl).hostname;
          payload.auth = ["localhost", "127.0.0.1", "::1"].includes(hostname)
            ? "local"
            : "configured";
        } catch {
          payload.auth = "missing";
        }
      }
    }
    return payload;
  } catch {
    return payload;
  }
};

const sanitizeCollection = (value, allowedStatuses) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!allowedStatuses.has(value.status)) return null;
  const count = Number(value.count);
  if (!Number.isInteger(count) || count < 0 || count > 100000) return null;
  return { status: value.status, count };
};

export const sanitizeSupabaseDiagnostic = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
  if (!CREDENTIAL_STATUSES.has(value.credentials)
    || !PROJECT_STATUSES.has(value.project)
    || !AUTH_STATUSES.has(value.auth)) return null;
  const tables = sanitizeCollection(
    value.tables,
    new Set(["complete", "incomplete", "unavailable"]),
  );
  const migrations = sanitizeCollection(
    value.migrations,
    new Set(["present", "empty", "unavailable"]),
  );
  if (!tables || !migrations) return null;
  return {
    version: 1,
    credentials: value.credentials,
    project: value.project,
    tables,
    migrations,
    auth: value.auth,
  };
};

export const inspectDockerSupabase = ({
  directory,
  runCommand = defaultRunCommand,
} = {}) => {
  try {
    const output = runCommand(
      "docker",
      [
        "compose", "run", "--rm", "--no-deps", "-T", "diagnostics",
      ],
      { cwd: directory },
    );
    for (const line of output.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const diagnostic = sanitizeSupabaseDiagnostic(JSON.parse(line));
        if (diagnostic) return { status: "ready", ...diagnostic };
      } catch {
        // Ignore non-JSON Compose output without returning it to the caller.
      }
    }
  } catch {
    // The caller reports a generic, secret-free Docker diagnostic failure.
  }
  return { status: "unavailable" };
};

export const reportDockerSupabase = (diagnostic, { fail, ok, warn }) => {
  const reconfigure = "corré: npm run levantar -- --docker --reconfigure";
  if (diagnostic?.status !== "ready") {
    warn("No pude ejecutar el diagnóstico cifrado de Supabase en Docker", reconfigure);
    return;
  }
  if (diagnostic.credentials !== "ready") {
    warn("Las credenciales cifradas de Supabase no están disponibles en Docker", reconfigure);
    return;
  }

  if (diagnostic.project === "healthy") ok("Proyecto Supabase sano", "credenciales cifradas de Docker");
  else if (diagnostic.project === "paused") {
    fail("El proyecto Supabase está pausado", "Despertalo desde el dashboard de Supabase.");
  } else if (diagnostic.project === "unhealthy") warn("El proyecto Supabase no está saludable");
  else fail("No pude validar el proyecto Supabase desde Docker", "Revisá la conexión y volvé a intentar.");

  if (diagnostic.tables.status === "complete") ok(`${diagnostic.tables.count} tablas en public`);
  else if (diagnostic.tables.status === "incomplete") {
    fail(`Solo ${diagnostic.tables.count} tablas en public`, reconfigure);
  } else fail("No pude consultar las tablas de Supabase desde Docker");

  if (diagnostic.migrations.status === "present") {
    ok(`${diagnostic.migrations.count} migraciones registradas`);
  } else if (diagnostic.migrations.status === "empty") warn("No hay migraciones registradas");
  else fail("No pude leer el historial de migraciones desde Docker");

  if (diagnostic.auth === "configured") ok("Site URL pública configurada en Supabase Auth");
  else if (diagnostic.auth === "local") {
    warn("Site URL de Supabase Auth todavía apunta a localhost", reconfigure);
  } else if (diagnostic.auth === "missing") fail("Site URL de Supabase Auth está vacía", reconfigure);
  else fail("No pude revisar Supabase Auth desde Docker");
};
