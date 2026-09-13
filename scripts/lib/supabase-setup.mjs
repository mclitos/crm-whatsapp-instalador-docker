import { generarDbPass } from "./supabase.mjs";

const PROGRESS_MESSAGES = Object.freeze({
  validating_account: "Validando la cuenta de Supabase.",
  storing_database_password: "Guardando la contraseña de la base de forma cifrada.",
  creating_project: "Creando el proyecto en Supabase.",
  storing_project_ref: "Guardando la referencia del proyecto.",
  waiting_project: "Esperando a que la base esté saludable.",
  fetching_keys: "Obteniendo la configuración de API.",
  preparing_workspace: "Preparando el código del CRM.",
  preparing_migrations: "Preparando el historial de migraciones.",
  applying_migrations: "Aplicando migraciones en orden.",
  verifying_schema: "Verificando el esquema final.",
  configuring_auth: "Configurando las URL de Auth.",
  writing_environment: "Escribiendo crm/.env.local de forma segura.",
  completed: "Supabase y el CRM quedaron configurados.",
});

export const PROGRESS_STAGES = new Set(Object.keys(PROGRESS_MESSAGES));

const TUNNEL_HOST = /\.(trycloudflare\.com|loca\.lt|ngrok\.io|ngrok-free\.app|serveo\.net)$/iu;

export class SupabaseSetupError extends Error {
  constructor(code, publicMessage, options = {}) {
    super(publicMessage, options);
    this.name = "SupabaseSetupError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.statusCode = options.statusCode || 502;
  }
}

const requireOk = (response, code, publicMessage) => {
  if (response?.ok) return response;
  throw new SupabaseSetupError(code, publicMessage);
};

const authOptions = (publicUrl) => {
  const siteUrl = publicUrl || "http://localhost:3000";
  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new SupabaseSetupError("INVALID_PUBLIC_URL", "La URL pública no tiene un formato válido.", { statusCode: 400 });
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  return {
    siteUrl: siteUrl.replace(/\/+$/u, ""),
    autoconfirmar: local || TUNNEL_HOST.test(parsed.hostname),
    mode: local ? "local" : TUNNEL_HOST.test(parsed.hostname) ? "tunnel" : "stable",
  };
};

const createProgressReporter = (onProgress) => async (stage, details = {}) => {
  if (!PROGRESS_STAGES.has(stage)) throw new Error(`Unknown progress stage: ${stage}`);
  const event = { stage, message: PROGRESS_MESSAGES[stage] };
  if (Number.isInteger(details.current)) event.current = details.current;
  if (Number.isInteger(details.total)) event.total = details.total;
  await onProgress(event);
};

const resolveProject = async ({ input, admin, credentialStore, organizations, report, generateDbPassword }) => {
  if (input.mode === "existing") {
    const project = requireOk(
      await admin.proyecto(input.ref),
      "PROJECT_NOT_FOUND",
      "No pude abrir el proyecto elegido. Revisá que todavía exista y que el token tenga acceso.",
    );
    await credentialStore.update({ supabaseProjectRef: input.ref });
    return { ref: input.ref, project: project.json, created: false };
  }

  const organizationExists = organizations.some((organization) => organization.slug === input.organizationSlug);
  if (!organizationExists) {
    throw new SupabaseSetupError(
      "ORGANIZATION_NOT_FOUND",
      "La organización elegida ya no está disponible para este token.",
      { statusCode: 422 },
    );
  }

  const dbPassword = generateDbPassword();
  await report("storing_database_password");
  await credentialStore.update({ supabaseProjectRef: null, supabaseDbPassword: dbPassword });
  await report("creating_project");
  let created;
  try {
    created = await admin.crearProyecto({
      nombre: input.name,
      dbPass: dbPassword,
      organizacion: input.organizationSlug,
      region: input.region || "sa-east-1",
      plan: "free",
    });
  } catch (error) {
    throw new SupabaseSetupError(
      "PROJECT_CREATION_AMBIGUOUS",
      "Supabase no confirmó si creó el proyecto. Revisá el panel antes de volver a intentar.",
      { cause: error },
    );
  }
  if (!created?.ok) {
    if (!created || !Number.isInteger(created.status) || created.status === 0 || created.status >= 500) {
      throw new SupabaseSetupError(
        "PROJECT_CREATION_AMBIGUOUS",
        "Supabase no confirmó si creó el proyecto. Revisá el panel antes de volver a intentar.",
      );
    }
    throw new SupabaseSetupError(
      "PROJECT_CREATION_FAILED",
      "Supabase rechazó la creación del proyecto. Revisá el límite de proyectos y la organización elegida.",
      { statusCode: 422 },
    );
  }
  const ref = created.json?.ref || created.json?.id;
  if (!ref) {
    throw new SupabaseSetupError(
      "PROJECT_CREATION_AMBIGUOUS",
      "Supabase creó una respuesta sin referencia. Revisá el panel antes de volver a intentar.",
    );
  }
  await report("storing_project_ref");
  try {
    await credentialStore.update({ supabaseProjectRef: ref, supabaseDbPassword: dbPassword });
  } catch (error) {
    throw new SupabaseSetupError(
      "PROJECT_REF_PERSIST_FAILED",
      "El proyecto fue creado, pero no pude guardar su referencia. No vuelvas a crearlo: revisá los permisos de /data.",
      { cause: error },
    );
  }
  return { ref, project: created.json, created: true };
};

const applyMigrations = async ({ admin, ref, workspace, report }) => {
  const migrations = await workspace.readMigrations();
  await report("preparing_migrations", { current: 0, total: migrations.length });
  requireOk(
    await admin.prepararTablaMigraciones(ref),
    "MIGRATION_TABLE_FAILED",
    "No pude preparar el historial de migraciones.",
  );

  let appliedVersions;
  try {
    appliedVersions = await admin.migracionesAplicadas(ref);
  } catch (error) {
    throw new SupabaseSetupError(
      "MIGRATION_READ_FAILED",
      "No pude leer las migraciones ya aplicadas. No es seguro continuar.",
      { cause: error },
    );
  }

  let applied = 0;
  let skipped = 0;
  for (const [index, migration] of migrations.entries()) {
    await report("applying_migrations", { current: index + 1, total: migrations.length });
    if (appliedVersions.has(migration.version)) {
      skipped += 1;
      continue;
    }
    const executed = await admin.aplicarMigracion(ref, migration);
    if (!executed?.ok) {
      throw new SupabaseSetupError(
        "MIGRATION_FAILED",
        `Supabase no confirmó la migración ${migration.fileName}. El SQL y su historial se guardan juntos: reintentá; si ya quedó aplicada, se salteará automáticamente.`,
      );
    }
    applied += 1;
  }
  return { applied, skipped, total: migrations.length };
};

export const provisionSupabase = async (
  input,
  {
    admin,
    workspace,
    credentialStore,
    generateDbPassword = generarDbPass,
    onProgress = async () => {},
  },
) => {
  const report = createProgressReporter(onProgress);
  await report("validating_account");
  const organizationResponse = requireOk(
    await admin.organizaciones(),
    "ACCOUNT_VALIDATION_FAILED",
    "No pude validar la cuenta de Supabase. Revisá el token y la conexión a internet.",
  );
  const organizations = Array.isArray(organizationResponse.json) ? organizationResponse.json : [];
  await workspace.clearReady();

  const selection = await resolveProject({
    input,
    admin,
    credentialStore,
    organizations,
    report,
    generateDbPassword,
  });
  await report("waiting_project");
  const health = await admin.esperarProyecto(selection.ref);
  if (!health?.ok) {
    throw new SupabaseSetupError(
      "PROJECT_UNHEALTHY",
      "El proyecto no llegó a estar saludable. Revisalo en Supabase y reintentá cuando esté verde.",
    );
  }

  await report("fetching_keys");
  const keys = requireOk(
    await admin.llaves(selection.ref),
    "API_KEYS_FAILED",
    "No pude obtener las llaves de API del proyecto.",
  );

  await report("preparing_workspace");
  await workspace.ensure(input.repoUrl);
  const migrationSummary = await applyMigrations({ admin, ref: selection.ref, workspace, report });

  await report("verifying_schema");
  const verifySql = await workspace.readVerifySchema();
  if (verifySql) {
    requireOk(
      await admin.sql(selection.ref, verifySql),
      "SCHEMA_VERIFICATION_FAILED",
      "La verificación final del esquema falló. Alguna migración pudo quedar incompleta.",
    );
  }

  const auth = authOptions(input.publicUrl);
  await report("configuring_auth");
  requireOk(
    await admin.configurarAuth(selection.ref, {
      siteUrl: auth.siteUrl,
      autoconfirmar: auth.autoconfirmar,
    }),
    "AUTH_CONFIGURATION_FAILED",
    "No pude configurar las URL de Auth en Supabase.",
  );

  await report("writing_environment");
  const locale = await workspace.detectLocale();
  await workspace.writeEnvironment({
    supabaseUrl: keys.url,
    anonKey: keys.anon,
    serviceRoleKey: keys.serviceRole,
    publicUrl: auth.siteUrl,
    locale,
    metaAppId: input.metaAppId || "",
    metaAppSecret: input.metaAppSecret || "",
  });
  await workspace.markReady();
  await report("completed");

  return {
    ref: selection.ref,
    projectName: typeof selection.project?.name === "string" ? selection.project.name : input.name || "",
    created: selection.created,
    migrations: migrationSummary,
    auth: { mode: auth.mode, siteUrl: auth.siteUrl },
    locale,
  };
};
