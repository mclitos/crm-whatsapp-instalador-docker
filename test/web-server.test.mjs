import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, test } from "node:test";

import {
  createWebInstallerServer,
  startWebInstaller,
} from "../scripts/web/server.mjs";

const servers = [];

const startServer = async (
  connectSupabase,
  {
    allowedOrigins,
    listenHost = "127.0.0.1",
    requestHost = listenHost,
    setupToken,
  } = {},
) => {
  const server = createWebInstallerServer({ allowedOrigins, connectSupabase, setupToken });
  servers.push(server);
  server.listen(0, listenHost);
  await once(server, "listening");
  const { port } = server.address();
  return { server, origin: `http://${requestHost}:${port}` };
};

const closeServer = async (server) => {
  server.close();
  await once(server, "close");
};

const openSession = async (origin) => {
  const response = await fetch(origin);
  const html = await response.text();
  const csrfToken = html.match(/<meta name="csrf-token" content="([^"]+)"/u)?.[1];
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(csrfToken);
  assert.ok(cookie);
  return { csrfToken, cookie };
};

const postConnection = async (origin, session, body) => fetch(`${origin}/api/supabase/connect`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: session.cookie,
    Origin: origin,
    "X-CSRF-Token": session.csrfToken,
  },
  body: JSON.stringify(body),
});

const rawRequest = (url, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const request = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method,
    headers,
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({
      statusCode: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  request.on("error", reject);
  request.end(body);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

test("the web installer defaults to loopback port 7359", async () => {
  const server = await startWebInstaller();
  servers.push(server);

  assert.deepEqual(server.address(), {
    address: "127.0.0.1",
    family: "IPv4",
    port: 7359,
  });
});

test("public binding is rejected when setup authentication is disabled", async () => {
  await assert.rejects(
    startWebInstaller({ host: "0.0.0.0", port: 0, setupAuthentication: false }),
    /autenticación de configuración/u,
  );
});

test("public binding generates a strong setup token when none is configured", async () => {
  let generatedToken;
  const server = await startWebInstaller({
    host: "0.0.0.0",
    port: 0,
    setupAuthentication: true,
    onSetupToken: (token) => { generatedToken = token; },
  });
  servers.push(server);

  assert.match(generatedToken, /^[A-Za-z0-9_-]{43}$/u);
});

test("startup rejects empty, whitespace, and short configured setup tokens", async () => {
  for (const setupToken of ["", "   ", "short-token"]) {
    await assert.rejects(
      startWebInstaller({
        host: "0.0.0.0",
        port: 0,
        setupAuthentication: true,
        setupToken,
      }),
      /WEB_INSTALLER_SETUP_TOKEN.*32/u,
    );
  }
});

test("allowed origins reject wildcards, credentials, paths, parameters, fragments, and malformed values", () => {
  for (const allowedOrigins of [
    "*",
    "http://user:password@192.168.9.45:7359",
    "http://192.168.9.45:7359/admin",
    "http://192.168.9.45:7359?mode=unsafe",
    "http://192.168.9.45:7359#unsafe",
    "ftp://192.168.9.45:7359",
    "not-an-origin",
  ]) {
    assert.throws(
      () => createWebInstallerServer({ allowedOrigins }),
      /origen permitido/u,
    );
  }
});

test("healthz is public but still rejects an attacker Host", async () => {
  const { origin } = await startServer(
    async () => ({ organizationCount: 1, project: null }),
    { setupToken: "container-setup-secret" },
  );

  const healthy = await fetch(`${origin}/healthz`);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true });

  const { port } = new URL(origin);
  const attacker = await rawRequest(`${origin}/healthz`, {
    headers: { Host: `attacker.example:${port}` },
  });
  assert.equal(attacker.statusCode, 403);
  assert.equal(attacker.body.includes("container-setup-secret"), false);
});

test("container mode requires a session before showing or using Supabase", async () => {
  let called = false;
  const setupToken = "container-setup-secret";
  const { origin } = await startServer(
    async () => {
      called = true;
      return { organizationCount: 1, project: null };
    },
    { setupToken },
  );

  const page = await fetch(origin);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /Ingresá el token de configuración/u);
  assert.doesNotMatch(html, /supabase-access-token/u);
  assert.equal(html.includes(setupToken), false);

  const response = await fetch(`${origin}/api/supabase/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ supabaseAccessToken: "sbp_unauthenticated" }),
  });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("the setup token is exchanged once for an authenticated session", async () => {
  const setupToken = "container-one-time-secret";
  const { origin } = await startServer(
    async () => ({ organizationCount: 1, project: null }),
    { setupToken },
  );

  const exchange = async () => fetch(`${origin}/api/setup/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ setupToken }),
  });

  const first = await exchange();
  const firstBody = await first.text();
  const setCookie = first.headers.get("set-cookie");
  const sessionCookie = setCookie?.split(";", 1)[0];
  assert.equal(first.status, 204);
  assert.ok(sessionCookie?.startsWith("web_installer_session="));
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /SameSite=Strict/u);
  assert.equal(firstBody.includes(setupToken), false);
  assert.equal(JSON.stringify([...first.headers]).includes(setupToken), false);

  const second = await exchange();
  assert.equal(second.status, 401);
  assert.equal((await second.text()).includes(setupToken), false);

  const authenticatedPage = await fetch(origin, { headers: { Cookie: sessionCookie } });
  const authenticatedHtml = await authenticatedPage.text();
  assert.match(authenticatedHtml, /supabase-access-token/u);
  assert.equal(authenticatedHtml.includes(setupToken), false);
});

test("failed setup-token exchanges are throttled without blocking the valid token", async () => {
  const setupToken = "container-rate-limit-secret";
  const { origin } = await startServer(
    async () => ({ organizationCount: 1, project: null }),
    { setupToken },
  );
  const exchange = (candidate) => fetch(`${origin}/api/setup/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ setupToken: candidate }),
  });

  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.equal((await exchange(`wrong-token-${attempt}`)).status, 401);
  }
  const throttled = await exchange("wrong-token-5");
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "30");
  assert.equal((await throttled.text()).includes(setupToken), false);

  const valid = await exchange(setupToken);
  assert.equal(valid.status, 204);
  assert.ok(valid.headers.get("set-cookie")?.startsWith("web_installer_session="));
});

test("an exact configured LAN origin preserves token authentication and CSRF defenses", async () => {
  const allowedOrigin = "http://192.168.9.45:7359";
  const setupToken = "test-only-lan-setup-token";
  let connectionCalls = 0;
  const { origin } = await startServer(
    async () => {
      connectionCalls += 1;
      return { organizationCount: 1, project: null };
    },
    { allowedOrigins: allowedOrigin, setupToken },
  );
  const internalPort = new URL(origin).port;

  const internalHealth = await rawRequest(`${origin}/healthz`, {
    headers: { Host: `127.0.0.1:${internalPort}` },
  });
  assert.equal(internalHealth.statusCode, 200);

  const login = await rawRequest(origin, { headers: { Host: "192.168.9.45:7359" } });
  assert.equal(login.statusCode, 200);
  assert.match(login.body, /Ingresá el token de configuración/u);
  assert.equal(login.body.includes(setupToken), false);

  for (const host of ["192.168.9.46:7359", "attacker.example:7359"]) {
    const rejected = await rawRequest(origin, { headers: { Host: host } });
    assert.equal(rejected.statusCode, 403);
  }

  const exchangeBody = JSON.stringify({ setupToken });
  const wrongOrigin = await rawRequest(`${origin}/api/setup/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(exchangeBody),
      Host: "192.168.9.45:7359",
      Origin: "http://192.168.9.46:7359",
      "Sec-Fetch-Site": "same-origin",
    },
    body: exchangeBody,
  });
  assert.equal(wrongOrigin.statusCode, 403);

  const exchange = await rawRequest(`${origin}/api/setup/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(exchangeBody),
      Host: "192.168.9.45:7359",
      Origin: allowedOrigin,
      "Sec-Fetch-Site": "same-origin",
    },
    body: exchangeBody,
  });
  assert.equal(exchange.statusCode, 204);
  const sessionCookie = String(exchange.headers["set-cookie"]).split(";", 1)[0];
  assert.match(String(exchange.headers["set-cookie"]), /HttpOnly/u);
  assert.match(String(exchange.headers["set-cookie"]), /SameSite=Strict/u);

  const page = await rawRequest(origin, {
    headers: { Cookie: sessionCookie, Host: "192.168.9.45:7359" },
  });
  assert.equal(page.statusCode, 200);
  const csrfToken = page.body.match(/<meta name="csrf-token" content="([^"]+)"/u)?.[1];
  const csrfCookie = String(page.headers["set-cookie"]).split(";", 1)[0];
  assert.ok(csrfToken);

  const connectionBody = JSON.stringify({ supabaseAccessToken: "sbp_lan-test-value" });
  const mismatchedOrigin = await rawRequest(`${origin}/api/supabase/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(connectionBody),
      Cookie: `${sessionCookie}; ${csrfCookie}`,
      Host: "192.168.9.45:7359",
      Origin: "http://attacker.example:7359",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrfToken,
    },
    body: connectionBody,
  });
  assert.equal(mismatchedOrigin.statusCode, 403);
  assert.equal(connectionCalls, 0);

  const accepted = await rawRequest(`${origin}/api/supabase/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(connectionBody),
      Cookie: `${sessionCookie}; ${csrfCookie}`,
      Host: "192.168.9.45:7359",
      Origin: allowedOrigin,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrfToken,
    },
    body: connectionBody,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(connectionCalls, 1);
});

test("an authenticated container session still requires valid CSRF proof", async () => {
  let called = false;
  const setupToken = "container-session-with-csrf";
  const { origin } = await startServer(
    async () => {
      called = true;
      return { organizationCount: 1, project: null };
    },
    { setupToken },
  );

  const exchange = await fetch(`${origin}/api/setup/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ setupToken }),
  });
  const sessionCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(sessionCookie);

  const page = await fetch(origin, { headers: { Cookie: sessionCookie } });
  const html = await page.text();
  const csrfToken = html.match(/<meta name="csrf-token" content="([^"]+)"/u)?.[1];
  const csrfCookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(csrfToken);
  assert.ok(csrfCookie);

  const withoutCsrf = await fetch(`${origin}/api/supabase/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
      Origin: origin,
    },
    body: JSON.stringify({ supabaseAccessToken: "sbp_without-csrf" }),
  });
  assert.equal(withoutCsrf.status, 403);
  assert.equal(called, false);

  const connected = await postConnection(origin, {
    cookie: `${sessionCookie}; ${csrfCookie}`,
    csrfToken,
  }, { supabaseAccessToken: "sbp_authenticated-container" });
  assert.equal(connected.status, 200);
  assert.equal(called, true);
});

test("the connection API returns a safe success response without the token", async () => {
  const token = "sbp_api-secret-never-returned";
  const { origin } = await startServer(async () => ({ organizationCount: 2, project: null }));
  const session = await openSession(origin);

  const response = await postConnection(origin, session, {
    supabaseAccessToken: token,
    supabaseProjectRef: "",
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(text.includes(token), false);
  assert.deepEqual(JSON.parse(text), {
    ok: true,
    message: "Conexión validada y guardada de forma segura.",
    organizationCount: 2,
    project: null,
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/u);
});

test("unexpected failures cannot reflect a token through the API", async () => {
  const token = "sbp_failure-secret-never-returned";
  const { origin } = await startServer(async () => {
    throw new Error(`Unexpected failure involving ${token}`);
  });
  const session = await openSession(origin);

  const response = await postConnection(origin, session, { supabaseAccessToken: token });
  const text = await response.text();

  assert.equal(response.status, 500);
  assert.equal(text.includes(token), false);
  assert.deepEqual(JSON.parse(text), {
    ok: false,
    message: "No pude completar la conexión. Volvé a intentarlo.",
  });
});

test("state-changing requests require same-origin and CSRF proof", async () => {
  let called = false;
  const { origin } = await startServer(async () => {
    called = true;
    return { organizationCount: 1, project: null };
  });

  const response = await fetch(`${origin}/api/supabase/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: JSON.stringify({ supabaseAccessToken: "sbp_csrf-test" }),
  });

  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("a legitimate localhost session can submit a state-changing request", async () => {
  let called = false;
  const { origin } = await startServer(
    async () => {
      called = true;
      return { organizationCount: 1, project: null };
    },
    { listenHost: "localhost" },
  );
  const session = await openSession(origin);

  const response = await postConnection(origin, session, {
    supabaseAccessToken: "sbp_localhost-regression",
  });

  assert.equal(response.status, 200);
  assert.equal(called, true);
});

test("a non-loopback Host cannot establish a browser session", async () => {
  const { origin } = await startServer(async () => ({ organizationCount: 1, project: null }));
  const { port } = new URL(origin);

  const response = await rawRequest(origin, { headers: { Host: `attacker.example:${port}` } });

  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["set-cookie"], undefined);
});

test("a non-loopback Host and matching Origin cannot submit a request", async () => {
  let called = false;
  const { origin } = await startServer(async () => {
    called = true;
    return { organizationCount: 1, project: null };
  });
  const session = await openSession(origin);
  const { port } = new URL(origin);
  const attackerAuthority = `attacker.example:${port}`;

  const body = JSON.stringify({ supabaseAccessToken: "sbp_dns-rebinding" });
  const response = await rawRequest(`${origin}/api/supabase/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Cookie: session.cookie,
      Host: attackerAuthority,
      Origin: `http://${attackerAuthority}`,
      "X-CSRF-Token": session.csrfToken,
    },
    body,
  });

  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
});

test("the browser page is accessible and explains this slice boundary", async () => {
  const { origin } = await startServer(async () => ({ organizationCount: 1, project: null }));
  const response = await fetch(origin);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<label for="supabase-access-token">/u);
  assert.match(html, /type="password"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /todavía no crea el proyecto ni aplica migraciones/u);
});

test("a successful polling response triggers handoff only after the response finishes", async () => {
  let observed = 0;
  const server = createWebInstallerServer({
    getSetupJob: async () => ({
      id: "job-success",
      status: "succeeded",
      stage: "completed",
      progress: { current: 1, total: 1, message: "Complete" },
      error: null,
      statusUrl: "/api/jobs/job-success",
    }),
    onSuccessfulSetupObserved() { observed += 1; },
    startSetupJob: async () => { throw new Error("not used"); },
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${origin}/api/jobs/job-success`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-crm-installer"), "1");
  assert.equal((await response.json()).job.status, "succeeded");
  for (let attempt = 0; attempt < 20 && observed === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(observed, 1);
});
