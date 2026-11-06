import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const expectedStdout = `
  CRM de WhatsApp — instalador
  De 41 pasos manuales a cuatro credenciales y un comando.
  El CRM es wacrm (MIT). Este instalador es de IABYIA.

creds
paso1
HEADER:Antes de conectar WhatsApp

  El paso 2 le pide a Meta que verifique tu webhook, así que el CRM tiene
  que estar respondiendo en https://example.invalid ahora mismo.

paso2
check
`;

const runInstaller = async (t, checkCode) => {
  const directory = await mkdtemp(join(tmpdir(), "crm-installer-exit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, "scripts");
  await mkdir(join(scripts, "lib"), { recursive: true });
  const source = await readFile(new URL("../scripts/instalar.mjs", import.meta.url), "utf8");
  await writeFile(join(scripts, "instalar.mjs"), source);
  // Only the CLI orchestrator is real: all side-effecting steps and UI inputs
  // are fixtures, so running this command cannot configure Supabase or Meta.
  await writeFile(join(scripts, "lib", "ui.mjs"), `
    export const ROOT = ${JSON.stringify(directory)};
    export const CRM_DIR = "unused";
    export const C = { bold: value => value, dim: value => value };
    export const encabezado = value => console.log("HEADER:" + value);
    export const info = () => {};
    export const leerEnv = () => ({ PUBLIC_URL: "https://example.invalid" });
    export const confirmar = async () => true;
    export const salir = code => process.exit(code);
    export const rutaCredenciales = () => "unused";
    export const verificarNode = () => {};
  `);
  for (const [name, output] of [
    ["credenciales.mjs", "creds"],
    ["paso1-supabase.mjs", "paso1"],
    ["paso2-meta.mjs", "paso2"],
  ]) {
    await writeFile(join(scripts, name), `console.log(${JSON.stringify(output)});\n`);
  }
  await writeFile(join(scripts, "check.mjs"), `
    console.log("check");
    ${checkCode ? 'console.error("diagnóstico fallido de prueba");' : ""}
    process.exitCode = ${checkCode};
  `);
  return spawnSync(process.execPath, [join(scripts, "instalar.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 5000,
  });
};

test("the installer fails when its final diagnostic fails, preserving child output", async (t) => {
  const result = await runInstaller(t, 1);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, expectedStdout);
  assert.equal(result.stderr, "diagnóstico fallido de prueba\n");
});

test("a successful final diagnostic preserves the installer success and step order", async (t) => {
  const result = await runInstaller(t, 0);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, expectedStdout);
  assert.equal(result.stderr, "");
});
