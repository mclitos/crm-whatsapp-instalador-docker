#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CrmUpdateError, parseUpdateArguments, runCrmUpdate } from "../lib/crm-update.mjs";
import { readSourceRevision } from "../lib/crm-readiness.mjs";
import { readPinnedCrmVersion } from "../lib/crm-source.mjs";
import { CrmWorkspace, resolveCrmWorkspaceDir } from "../lib/crm-workspace.mjs";
import { SupabaseAdmin } from "../lib/supabase.mjs";
import { EncryptedCredentialStore } from "../web/encrypted-store.mjs";

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = "CRM_UPDATE_RESULT=";

const main = async () => {
  const options = parseUpdateArguments(process.argv.slice(2));
  const directory = resolveCrmWorkspaceDir();
  const target = options.commit ?? readPinnedCrmVersion().commit;

  let credentials;
  try {
    credentials = await new EncryptedCredentialStore().load({ createKey: false });
  } catch (error) {
    throw new CrmUpdateError(
      "CREDENTIALS_UNREADABLE",
      "No pude leer las credenciales cifradas de Supabase.",
      "Corré: npm run levantar -- --docker --reconfigure",
      { cause: error },
    );
  }
  if (!credentials?.supabaseAccessToken || !credentials?.supabaseProjectRef) {
    throw new CrmUpdateError(
      "CREDENTIALS_MISSING",
      "Faltan el token o el proyecto de Supabase en las credenciales cifradas.",
      "Corré: npm run levantar -- --docker --reconfigure",
    );
  }

  const git = async (args) => (await execFileAsync("git", ["-C", directory, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 8 * 1024 * 1024,
  })).stdout;

  const result = await runCrmUpdate({
    target,
    allowMigrations: options.allowMigrations,
    directory,
    git,
    admin: new SupabaseAdmin(credentials.supabaseAccessToken),
    ref: credentials.supabaseProjectRef,
    workspace: new CrmWorkspace({ directory }),
    readRevision: readSourceRevision,
    log: (line) => console.log(line),
  });

  if (result.status === "updated") {
    console.log(`Versión anterior: ${result.previous}`);
    console.log(`Versión nueva:    ${result.current}`);
    console.log(`Migraciones aplicadas: ${result.migrationsApplied}`);
    console.log(`Para volver a la anterior: ${result.rollbackCommand}`);
  }
  console.log(`${RESULT_PREFIX}${JSON.stringify({
    status: result.status,
    previous: result.previous,
    current: result.current,
  })}`);
};

main().catch((error) => {
  if (error instanceof CrmUpdateError) {
    console.error(`ERROR: ${error.message}`);
    console.error(`Cómo arreglarlo: ${error.action}`);
    process.exitCode = error.code === "MIGRATIONS_PENDING" ? 2 : 1;
    return;
  }
  console.error("ERROR: la actualización falló de forma inesperada.");
  console.error("Cómo arreglarlo: revisá que Docker y la conexión funcionen y repetí el comando; no se borró ningún dato.");
  process.exitCode = 1;
});
