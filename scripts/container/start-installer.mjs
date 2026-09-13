#!/usr/bin/env node

import { runInstallerRuntime } from "./installer-runtime.mjs";

try {
  await runInstallerRuntime();
  process.exitCode = 0;
} catch {
  console.error("Instalador: no pudo completar el ciclo seguro. El CRM no se iniciará.");
  process.exitCode = 1;
}
