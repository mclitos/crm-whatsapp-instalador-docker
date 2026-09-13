#!/usr/bin/env node

import { startWebInstaller } from "./web/server.mjs";

const rawPort = process.env.WEB_INSTALLER_PORT || "7359";
const port = Number(rawPort);
const host = process.env.WEB_INSTALLER_HOST || "127.0.0.1";
const setupToken = process.env.WEB_INSTALLER_SETUP_TOKEN || undefined;
const allowedOrigins = process.env.WEB_INSTALLER_ALLOWED_ORIGINS || "";
const defaultPublicUrl = process.env.CRM_PUBLIC_URL_DEFAULT || "http://localhost:3000";
const publicBinding = host === "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("✗ WEB_INSTALLER_PORT tiene que ser un puerto válido entre 1 y 65535.");
  process.exitCode = 1;
} else {
  try {
    const server = await startWebInstaller({
      allowedOrigins,
      defaultPublicUrl,
      host,
      port,
      setupAuthentication: publicBinding || Boolean(setupToken),
      setupToken,
      onSetupToken(token) {
        console.log("\n🔐 Token de configuración de un solo uso:");
        console.log(`   ${token}`);
        console.log("   Copialo ahora: no vuelve a mostrarse.\n");
      },
    });
    const address = server.address();
    const reachableUrl = allowedOrigins.split(",").map((value) => value.trim()).find(Boolean)
      || `http://127.0.0.1:${address.port}`;
    console.log(`\n✓ Instalador web: ${reachableUrl}`);
    console.log(publicBinding
      ? "  Protegido por token y limitado a los orígenes configurados.\n"
      : "  Solo acepta conexiones desde esta computadora. Ctrl+C para cerrarlo.\n");
  } catch (error) {
    const message = error.code === "EADDRINUSE"
      ? `El puerto ${port} ya está ocupado. Probá con WEB_INSTALLER_PORT=7360 npm run web.`
      : error.message || "No pude iniciar el instalador web.";
    console.error(`\n✗ ${message}\n`);
    process.exitCode = 1;
  }
}
