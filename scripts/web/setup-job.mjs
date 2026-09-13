import { resolve } from "node:path";

import { CrmWorkspace, resolveCrmWorkspaceDir } from "../lib/crm-workspace.mjs";
import { resolveCrmRepoUrl } from "../lib/crm-source.mjs";
import { provisionSupabase, PROGRESS_STAGES } from "../lib/supabase-setup.mjs";
import { SupabaseAdmin } from "../lib/supabase.mjs";
import { EncryptedCredentialStore } from "./encrypted-store.mjs";
import { JobConflictError, JobStore } from "./job-store.mjs";
import { validateSetupInput } from "./setup-input.mjs";

export { JobConflictError };

const DEFAULT_DATA_DIRECTORY = resolve(".web-installer");
const JOB_STAGES = new Set(["queued", ...PROGRESS_STAGES]);
const PROGRESS_MESSAGES = Object.freeze({
  queued: "Preparando la instalación.",
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

const SAFE_ERROR_MESSAGES = Object.freeze({
  ACCOUNT_VALIDATION_FAILED: "No pude validar la cuenta de Supabase. Revisá el token y la conexión a internet.",
  PROJECT_NOT_FOUND: "No pude abrir el proyecto elegido. Revisá que todavía exista y que el token tenga acceso.",
  ORGANIZATION_NOT_FOUND: "La organización elegida ya no está disponible para este token.",
  PROJECT_CREATION_FAILED: "Supabase rechazó la creación. Revisá el límite de proyectos y la organización elegida.",
  PROJECT_UNHEALTHY: "El proyecto no llegó a estar saludable. Reintentá cuando aparezca verde en Supabase.",
  API_KEYS_FAILED: "No pude obtener las llaves de API del proyecto.",
  MIGRATION_TABLE_FAILED: "No pude preparar el historial de migraciones.",
  MIGRATION_READ_FAILED: "No pude leer las migraciones ya aplicadas. No es seguro continuar.",
  MIGRATION_FAILED: "Una migración falló. Las anteriores quedaron registradas para el próximo intento.",
  MIGRATION_RECORD_FAILED: "Una migración se aplicó, pero no pudo registrarse. No es seguro continuar.",
  SCHEMA_VERIFICATION_FAILED: "La verificación final del esquema falló. Alguna migración pudo quedar incompleta.",
  AUTH_CONFIGURATION_FAILED: "No pude configurar las URL de Auth en Supabase.",
  INVALID_PUBLIC_URL: "La URL pública no tiene un formato válido.",
});

const safeFailure = (error) => {
  if (["PROJECT_CREATION_AMBIGUOUS", "PROJECT_REF_PERSIST_FAILED"].includes(error?.code)) {
    return {
      status: "needs_attention",
      stage: "needs_attention",
      error: {
        code: "project_creation_ambiguous",
        message: "Supabase pudo haber creado el proyecto. Revisá el panel antes de volver a intentar.",
      },
    };
  }
  const knownMessage = SAFE_ERROR_MESSAGES[error?.code]
    || "La configuración no pudo terminar. Revisá el paso indicado y volvé a intentar.";
  return {
    status: "failed",
    stage: "failed",
    error: { code: "setup_failed", message: knownMessage },
  };
};

class SetupJobService {
  constructor({ completionMessage, onSetupSucceeded, store, runSetup }) {
    this.completionMessage = completionMessage;
    this.onSetupSucceeded = onSetupSucceeded;
    this.store = store;
    this.runSetup = runSetup;
    this.successNotified = false;
  }

  async start(input) {
    const safeInput = validateSetupInput(input);
    const { snapshot, created } = await this.store.create(safeInput);
    if (created) queueMicrotask(() => void this.#execute(snapshot.id).catch(() => {}));
    return snapshot;
  }

  get(id) {
    return this.store.get(id);
  }

  async #execute(id) {
    const job = this.store.getInternal(id);
    if (!job) return;
    await this.store.update(id, {
      status: "running",
      stage: "validating_account",
      progress: { current: 0, total: 0, message: PROGRESS_MESSAGES.validating_account },
      error: null,
    });
    let succeededSnapshot;
    try {
      await this.runSetup(job.input, {
        onProgress: async (event) => {
          if (!JOB_STAGES.has(event?.stage)) return;
          await this.store.update(id, {
            status: "running",
            stage: event.stage,
            progress: {
              current: Number.isInteger(event.current) ? event.current : 0,
              total: Number.isInteger(event.total) ? event.total : 0,
              message: PROGRESS_MESSAGES[event.stage],
            },
          });
        },
      });
      succeededSnapshot = await this.store.update(id, {
        status: "succeeded",
        stage: "completed",
        progress: { current: 1, total: 1, message: this.completionMessage },
        error: null,
      });
    } catch (error) {
      await this.store.update(id, safeFailure(error));
      return;
    }

    if (this.successNotified) return;
    this.successNotified = true;
    try {
      await this.onSetupSucceeded(succeededSnapshot);
    } catch {
      // Provisioning is already durable; handoff failures must not rewrite it.
    }
  }
}

export const createSetupJobService = async ({
  automaticCrmStart = false,
  directory = process.env.WEB_INSTALLER_DATA_DIR || DEFAULT_DATA_DIRECTORY,
  onSetupSucceeded = async () => {},
  runSetup,
  now,
  idGenerator,
} = {}) => {
  const store = new JobStore({ directory, now, idGenerator });
  await store.initialize();
  const completionMessage = automaticCrmStart
    ? "Supabase quedó configurado. El CRM empieza a construirse y arrancar automáticamente."
    : PROGRESS_MESSAGES.completed;
  return new SetupJobService({ completionMessage, onSetupSucceeded, store, runSetup });
};

export const createDefaultSetupJobService = async ({
  environment = process.env,
  credentialStore = new EncryptedCredentialStore({ environment }),
  createAdmin = (token) => new SupabaseAdmin(token),
  onSetupSucceeded = async () => {},
  workspace = new CrmWorkspace({ directory: resolveCrmWorkspaceDir(environment) }),
} = {}) => createSetupJobService({
  automaticCrmStart: environment.CRM_AUTO_START === "1",
  directory: environment.WEB_INSTALLER_DATA_DIR || DEFAULT_DATA_DIRECTORY,
  onSetupSucceeded,
  async runSetup(input, { onProgress }) {
    const credentials = await credentialStore.load();
    const repoUrl = resolveCrmRepoUrl({ environment, credentials });
    return provisionSupabase(
      { ...input, repoUrl },
      {
        admin: createAdmin(credentials.supabaseAccessToken),
        credentialStore,
        workspace,
        onProgress,
      },
    );
  },
});
