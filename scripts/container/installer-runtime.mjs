import { inspectCurrentWorkspaceReadiness } from "../lib/crm-readiness.mjs";
import { startWebInstaller } from "../web/server.mjs";

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

export const runInstallerRuntime = async ({
  directory = process.env.CRM_WORKSPACE_DIR || "/workspace/crm",
  environment = process.env,
  fallbackMs = 15_000,
  inspectReadiness = inspectCurrentWorkspaceReadiness,
  logger = console,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  startInstaller = startWebInstaller,
} = {}) => {
  const readiness = await inspectReadiness(directory);
  if (readiness.status === "ready" && environment.CRM_FORCE_SETUP !== "1") {
    logger.info("Instalador: el workspace actual ya está listo; continúo con el CRM.");
    return { status: "already_ready" };
  }

  let server;
  let fallbackTimer;
  let handoffStarted = false;
  let successPersisted = false;
  let resolveHandoff;
  let rejectHandoff;
  const handoff = new Promise((resolve, reject) => {
    resolveHandoff = resolve;
    rejectHandoff = reject;
  });

  const completeHandoff = () => {
    if (!successPersisted || handoffStarted) return;
    handoffStarted = true;
    if (fallbackTimer !== undefined) cancelSchedule(fallbackTimer);
    void closeServer(server).then(resolveHandoff, rejectHandoff);
  };

  const armFallback = () => {
    successPersisted = true;
    if (fallbackTimer !== undefined || handoffStarted) return;
    fallbackTimer = schedule(completeHandoff, fallbackMs);
  };

  const rawPort = environment.WEB_INSTALLER_PORT || "7359";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WEB_INSTALLER_PORT must be a valid port.");
  }
  const host = environment.WEB_INSTALLER_HOST || "127.0.0.1";
  const setupToken = environment.WEB_INSTALLER_SETUP_TOKEN || undefined;
  server = await startInstaller({
    allowedOrigins: environment.WEB_INSTALLER_ALLOWED_ORIGINS || "",
    defaultPublicUrl: environment.CRM_PUBLIC_URL_DEFAULT || "http://localhost:3000",
    host,
    onSetupSucceeded: armFallback,
    onSuccessfulSetupObserved: completeHandoff,
    port,
    setupAuthentication: host === "0.0.0.0" || Boolean(setupToken),
    setupToken,
    onSetupToken(token) {
      logger.info("\n🔐 Token de configuración de un solo uso:");
      logger.info(`   ${token}`);
      logger.info("   Copialo ahora: no vuelve a mostrarse.\n");
    },
  });

  const address = server.address();
  const reachableUrl = (environment.WEB_INSTALLER_ALLOWED_ORIGINS || "")
    .split(",").map((value) => value.trim()).find(Boolean)
    || `http://127.0.0.1:${address.port}`;
  logger.info(`Instalador: disponible temporalmente en ${reachableUrl}`);
  await handoff;
  return { status: "provisioned" };
};
