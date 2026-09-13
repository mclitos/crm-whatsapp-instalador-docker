import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { renderConnectionPage } from "./page.mjs";
import {
  createSessionCookie,
  createSetupAuthentication,
  equalTokens,
  parseCookies,
} from "./setup-auth.mjs";
import { renderSetupPage } from "./setup-page.mjs";
import { validateSetupInput } from "./setup-input.mjs";
import { createDefaultSetupJobService } from "./setup-job.mjs";
import { connectSupabase as establishSupabaseConnection } from "./supabase-connection.mjs";
import { loadSupabaseOptions as loadStoredSupabaseOptions } from "./supabase-options.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const CSRF_TTL_MS = 30 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const parseAllowedOrigins = (value = "") => {
  if (typeof value !== "string") throw new Error("Cada origen permitido tiene que ser una URL HTTP o HTTPS exacta.");
  if (!value.trim()) return new Map();

  const originsByAuthority = new Map();
  for (const candidate of value.split(",")) {
    const configured = candidate.trim();
    let parsed;
    try {
      if (!configured || configured.includes("*")) throw new Error("Invalid origin");
      parsed = new URL(configured);
    } catch {
      throw new Error("Cada origen permitido tiene que ser una URL HTTP o HTTPS exacta.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) {
      throw new Error("Cada origen permitido tiene que ser una URL HTTP o HTTPS exacta, sin credenciales, ruta, parámetros ni fragmento.");
    }
    const authority = parsed.host.toLowerCase();
    if (originsByAuthority.has(authority)) {
      throw new Error("Cada autoridad puede tener un solo origen permitido.");
    }
    originsByAuthority.set(authority, parsed.origin);
  }
  return originsByAuthority;
};

const securityHeaders = (nonce) => ({
  "Cache-Control": "no-store",
  "Content-Security-Policy": nonce
    ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    : "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-CRM-Installer": "1",
  "X-Frame-Options": "DENY",
});

const send = (response, statusCode, body, contentType, nonce) => {
  response.writeHead(statusCode, {
    ...securityHeaders(nonce),
    "Content-Type": contentType,
  });
  response.end(body);
};

const sendJson = (response, statusCode, payload) => {
  send(response, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
};

const sendEmpty = (response, statusCode) => {
  response.writeHead(statusCode, securityHeaders());
  response.end();
};

const readJsonBody = (request, maxBytes) => new Promise((resolve, reject) => {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > maxBytes) {
    request.resume();
    reject(Object.assign(new Error("Body too large"), { statusCode: 413 }));
    return;
  }

  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      reject(Object.assign(new Error("Body too large"), { statusCode: 413 }));
      request.removeAllListeners("data");
      request.resume();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
    }
  });
  request.on("error", reject);
});

const expectedOriginFromHost = (request, configuredOrigins) => {
  const host = request.headers.host;
  if (typeof host !== "string") return null;

  const authority = host.toLowerCase();
  const configuredOrigin = configuredOrigins.get(authority);
  if (configuredOrigin) return configuredOrigin;

  const port = request.socket.localPort;
  const allowedAuthorities = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ]);
  if (!allowedAuthorities.has(authority)) return null;
  return new URL(`http://${authority}`).origin;
};

const isSameOriginRequest = (request, expectedOrigin) => {
  const fetchSite = request.headers["sec-fetch-site"];
  return request.headers.origin === expectedOrigin && (!fetchSite || fetchSite === "same-origin");
};

const hasJsonContentType = (request) => (
  (request.headers["content-type"] || "").toLowerCase().startsWith("application/json")
);

const redactStrings = (value, secret) => {
  if (typeof value === "string") return secret ? value.replaceAll(secret, "[redacted]") : value;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, secret));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, secret)]));
};

const sendRequestError = (response, error, secret) => {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const message = typeof error.publicMessage === "string"
    ? error.publicMessage
    : statusCode === 413
      ? "La solicitud es demasiado grande."
      : statusCode === 400
        ? "La solicitud no tiene un JSON válido."
        : "No pude completar la conexión. Volvé a intentarlo.";
  sendJson(response, statusCode, redactStrings({ ok: false, message }, secret));
};

const allowOptions = (options) => ({
  organizations: (Array.isArray(options?.organizations) ? options.organizations : []).map((item) => ({
    slug: typeof item?.slug === "string" ? item.slug : "",
    name: typeof item?.name === "string" ? item.name : "",
  })).filter((item) => item.slug),
  projects: (Array.isArray(options?.projects) ? options.projects : []).map((item) => ({
    ref: typeof item?.ref === "string" ? item.ref : "",
    name: typeof item?.name === "string" ? item.name : "",
    region: typeof item?.region === "string" ? item.region : "",
    status: typeof item?.status === "string" ? item.status : "UNKNOWN",
  })).filter((item) => item.ref),
});

const allowJobSnapshot = (job) => job && ({
  id: typeof job.id === "string" ? job.id : "",
  status: typeof job.status === "string" ? job.status : "failed",
  stage: typeof job.stage === "string" ? job.stage : "failed",
  progress: {
    current: Number.isInteger(job.progress?.current) ? job.progress.current : 0,
    total: Number.isInteger(job.progress?.total) ? job.progress.total : 0,
    message: typeof job.progress?.message === "string" ? job.progress.message : "",
  },
  error: job.error && typeof job.error === "object" ? {
    code: typeof job.error.code === "string" ? job.error.code : "setup_failed",
    message: typeof job.error.message === "string" ? job.error.message : "La configuración no pudo terminar.",
  } : null,
  createdAt: typeof job.createdAt === "string" ? job.createdAt : "",
  updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : "",
  statusUrl: typeof job.statusUrl === "string" ? job.statusUrl : `/api/jobs/${job.id}`,
});

export const createWebInstallerServer = ({
  allowedOrigins = process.env.WEB_INSTALLER_ALLOWED_ORIGINS || "",
  automaticCrmStart = process.env.CRM_AUTO_START === "1",
  connectSupabase = establishSupabaseConnection,
  defaultPublicUrl = process.env.CRM_PUBLIC_URL_DEFAULT || "http://localhost:3000",
  getSetupJob,
  loadSupabaseOptions = loadStoredSupabaseOptions,
  maxBodyBytes = MAX_BODY_BYTES,
  onSetupSucceeded = async () => {},
  onSuccessfulSetupObserved = () => {},
  setupToken,
  startSetupJob,
} = {}) => {
  const configuredOrigins = parseAllowedOrigins(allowedOrigins);
  const csrfSessions = new Map();
  const setupAuthentication = createSetupAuthentication({ setupToken });
  let defaultJobService;
  const getDefaultJobService = () => {
    defaultJobService ||= createDefaultSetupJobService({ onSetupSucceeded });
    return defaultJobService;
  };
  const customJobHandlers = Boolean(startSetupJob || getSetupJob);
  const startJob = startSetupJob || (customJobHandlers
    ? async () => { throw new Error("Setup job start handler is not configured"); }
    : async (input) => (await getDefaultJobService()).start(input));
  const getJob = getSetupJob || (customJobHandlers
    ? async () => null
    : async (id) => (await getDefaultJobService()).get(id));

  return createServer(async (request, response) => {
    const expectedOrigin = expectedOriginFromHost(request, configuredOrigins);
    if (!expectedOrigin) {
      request.resume();
      sendJson(response, 403, { ok: false, message: "El instalador solo acepta solicitudes locales." });
      return;
    }

    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    const authenticated = setupAuthentication.isAuthenticated(request.headers.cookie);
    if (request.method === "GET" && request.url === "/") {
      const nonce = randomBytes(18).toString("base64url");
      if (!authenticated) {
        send(response, 200, renderSetupPage({ nonce }), "text/html; charset=utf-8", nonce);
        return;
      }

      const csrfToken = randomBytes(32).toString("base64url");
      csrfSessions.set(csrfToken, Date.now() + CSRF_TTL_MS);
      for (const [token, expiresAt] of csrfSessions) {
        if (expiresAt < Date.now()) csrfSessions.delete(token);
      }
      response.setHeader(
        "Set-Cookie",
        `web_installer_csrf=${csrfToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
      );
      send(response, 200, renderConnectionPage({
        automaticCrmStart,
        csrfToken,
        defaultPublicUrl,
        nonce,
      }), "text/html; charset=utf-8", nonce);
      return;
    }

    if (request.method === "POST" && request.url === "/api/setup/session") {
      if (!setupAuthentication.required) {
        request.resume();
        sendJson(response, 404, { ok: false, message: "Ruta no encontrada." });
        return;
      }
      if (!isSameOriginRequest(request, expectedOrigin)) {
        request.resume();
        sendJson(response, 403, { ok: false, message: "La solicitud no es segura." });
        return;
      }
      if (!hasJsonContentType(request)) {
        request.resume();
        sendJson(response, 415, { ok: false, message: "El contenido tiene que ser JSON." });
        return;
      }

      try {
        const body = await readJsonBody(request, maxBodyBytes);
        const exchange = setupAuthentication.exchange(body?.setupToken);
        if (exchange.status === "throttled") {
          response.setHeader("Retry-After", String(exchange.retryAfterSeconds));
          sendJson(response, 429, {
            ok: false,
            message: "Hubo demasiados intentos fallidos. Esperá unos segundos y volvé a intentar.",
          });
          return;
        }
        if (exchange.status !== "authenticated") {
          sendJson(response, 401, { ok: false, message: "El token no es válido o ya fue utilizado." });
          return;
        }
        response.setHeader("Set-Cookie", createSessionCookie(exchange.session));
        sendEmpty(response, 204);
      } catch (error) {
        sendRequestError(response, error);
      }
      return;
    }

    if (!authenticated) {
      request.resume();
      sendJson(response, 401, { ok: false, message: "Primero ingresá el token de configuración." });
      return;
    }

    if (request.method === "GET" && request.url === "/api/supabase/options") {
      try {
        const options = allowOptions(await loadSupabaseOptions());
        sendJson(response, 200, { ok: true, ...options });
      } catch (error) {
        sendRequestError(response, error);
      }
      return;
    }

    const jobMatch = request.method === "GET"
      ? request.url?.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/u)
      : null;
    if (jobMatch) {
      try {
        const job = allowJobSnapshot(await getJob(jobMatch[1]));
        if (!job) {
          sendJson(response, 404, { ok: false, message: "No encontré ese trabajo de configuración." });
          return;
        }
        if (job.status === "succeeded") {
          response.once("finish", () => {
            Promise.resolve().then(() => onSuccessfulSetupObserved(job)).catch(() => {});
          });
        }
        sendJson(response, 200, { ok: true, job });
      } catch (error) {
        sendRequestError(response, error);
      }
      return;
    }

    const stateChangingRoute = request.method === "POST"
      && ["/api/supabase/connect", "/api/supabase/setup"].includes(request.url);
    if (!stateChangingRoute) {
      sendJson(response, 404, { ok: false, message: "Ruta no encontrada." });
      return;
    }

    const headerToken = request.headers["x-csrf-token"];
    const cookieToken = parseCookies(request.headers.cookie).web_installer_csrf;
    const csrfExpiresAt = csrfSessions.get(cookieToken);
    const csrfValid = csrfExpiresAt > Date.now()
      && equalTokens(cookieToken, headerToken)
      && isSameOriginRequest(request, expectedOrigin);

    if (!csrfValid) {
      request.resume();
      sendJson(response, 403, {
        ok: false,
        message: "La sesión local venció o la solicitud no es segura. Recargá la página.",
      });
      return;
    }
    if (!hasJsonContentType(request)) {
      request.resume();
      sendJson(response, 415, { ok: false, message: "El contenido tiene que ser JSON." });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request, maxBodyBytes);
      if (request.url === "/api/supabase/connect") {
        const result = await connectSupabase(body);
        const payload = redactStrings({
          ok: true,
          message: "Conexión validada y guardada de forma segura.",
          organizationCount: result.organizationCount,
          project: result.project,
        }, body?.supabaseAccessToken);
        sendJson(response, 200, payload);
        return;
      }

      const input = validateSetupInput(
        body && typeof body === "object" && !Array.isArray(body) && !body.publicUrl
          ? { ...body, publicUrl: defaultPublicUrl }
          : body,
      );
      const job = allowJobSnapshot(await startJob(input));
      sendJson(response, 202, { ok: true, job });
    } catch (error) {
      sendRequestError(response, error, body?.supabaseAccessToken);
    }
  });
};

export const startWebInstaller = async ({
  allowedOrigins = process.env.WEB_INSTALLER_ALLOWED_ORIGINS || "",
  defaultPublicUrl = process.env.CRM_PUBLIC_URL_DEFAULT || "http://localhost:3000",
  host = "127.0.0.1",
  port = 7359,
  onSetupSucceeded = async () => {},
  onSuccessfulSetupObserved = () => {},
  setupAuthentication,
  setupToken,
  onSetupToken = () => {},
} = {}) => {
  if (setupToken !== undefined && setupToken !== null) {
    if (typeof setupToken !== "string"
      || /\s/u.test(setupToken)
      || setupToken.length < 32) {
      throw new Error(
        "WEB_INSTALLER_SETUP_TOKEN tiene que tener al menos 32 caracteres y no puede contener espacios.",
      );
    }
  }
  const loopback = LOOPBACK_HOSTS.has(host);
  const authenticationEnabled = setupAuthentication ?? Boolean(setupToken);
  if (!loopback && host !== "0.0.0.0") {
    throw new Error("El instalador web solo puede escuchar en loopback o 0.0.0.0.");
  }
  if (!loopback && !authenticationEnabled) {
    throw new Error("La escucha pública requiere autenticación de configuración.");
  }

  const configuredToken = typeof setupToken === "string" && setupToken.length > 0
    ? setupToken
    : null;
  const generatedToken = authenticationEnabled && !configuredToken
    ? randomBytes(32).toString("base64url")
    : null;
  const server = createWebInstallerServer({
    allowedOrigins,
    defaultPublicUrl,
    onSetupSucceeded,
    onSuccessfulSetupObserved,
    setupToken: configuredToken || generatedToken,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  if (generatedToken) onSetupToken(generatedToken);
  return server;
};
