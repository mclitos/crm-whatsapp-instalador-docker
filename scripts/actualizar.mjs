#!/usr/bin/env node
/**
 * npm run actualizar -- --docker — lleva el CRM instalado a la versión revisada.
 *
 * Trae el instalador, reconstruye la imagen, corre el actualizador dentro de
 * Docker (que se niega a tocar migraciones sin confirmación) y reinicia el CRM.
 * Con --commit <hash> se puede ir a cualquier versión, incluida una anterior.
 */

import { C, ROOT, encabezado, info, morir } from "./lib/ui.mjs";
import {
  ActualizarError,
  parseActualizarArguments,
  runDockerUpdate,
} from "./lib/actualizar-docker.mjs";

encabezado("Actualizando el CRM");

try {
  const options = parseActualizarArguments(process.argv.slice(2));
  if (!options.docker) {
    morir(
      "Por ahora solo se puede actualizar una instalación Docker.",
      "Corré: npm run actualizar -- --docker",
    );
  }
  info("Con Docker el CRM queda apagado unos 3 minutos mientras compila la versión nueva.");
  const result = await runDockerUpdate({ directory: ROOT, options });
  console.log(`\n${C.green(C.bold(result.status === "updated" ? "✓ CRM actualizado." : "✓ Sin cambios."))}\n`);
} catch (error) {
  if (error instanceof ActualizarError) morir(error.message, error.action);
  throw error;
}
