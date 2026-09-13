import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";

import { createWebInstallerServer } from "../scripts/web/server.mjs";

const servers = [];

const startServer = async (dependencies = {}, setupToken) => {
  const server = createWebInstallerServer({
    connectSupabase: async () => ({ organizationCount: 1, project: null }),
    ...dependencies,
    setupToken,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};

const authenticate = async (origin, setupToken) => {
  if (!setupToken) return "";
  const response = await fetch(`${origin}/api/setup/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ setupToken }),
  });
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
};

const openSession = async (origin, authenticationCookie = "") => {
  const response = await fetch(origin, { headers: authenticationCookie ? { Cookie: authenticationCookie } : {} });
  const html = await response.text();
  const csrfToken = html.match(/<meta name="csrf-token" content="([^"]+)"/u)?.[1];
  const csrfCookie = response.headers.get("set-cookie")?.split(";", 1)[0] || "";
  return {
    csrfToken,
    cookie: [authenticationCookie, csrfCookie].filter(Boolean).join("; "),
  };
};

const postSetup = async (origin, session, body) => fetch(`${origin}/api/supabase/setup`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: session.cookie,
    Origin: origin,
    "X-CSRF-Token": session.csrfToken,
  },
  body: JSON.stringify(body),
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
});

test("Supabase options require authentication and return only allowlisted fields", async () => {
  const setupToken = "setup-options-secret";
  let calls = 0;
  const origin = await startServer({
    async loadSupabaseOptions() {
      calls += 1;
      return {
        organizations: [{ slug: "team", name: "Team", billing_email: "must-not-leak@example.com" }],
        projects: [{ ref: "abcdefghijklmnopqrst", name: "CRM", region: "sa-east-1", status: "ACTIVE_HEALTHY", databasePassword: "must-not-leak" }],
      };
    },
  }, setupToken);

  const unauthenticated = await fetch(`${origin}/api/supabase/options`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(calls, 0);

  const cookie = await authenticate(origin, setupToken);
  const response = await fetch(`${origin}/api/supabase/options`, { headers: { Cookie: cookie } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    organizations: [{ slug: "team", name: "Team" }],
    projects: [{ ref: "abcdefghijklmnopqrst", name: "CRM", region: "sa-east-1", status: "ACTIVE_HEALTHY" }],
  });
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
});

test("setup validates input and requires same-origin CSRF proof", async () => {
  let calls = 0;
  const origin = await startServer({
    async startSetupJob() { calls += 1; return { id: "job-one", status: "queued" }; },
  });
  const session = await openSession(origin);

  const noCsrf = await fetch(`${origin}/api/supabase/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000", requestId: "request-one" }),
  });
  assert.equal(noCsrf.status, 403);

  const invalid = await postSetup(origin, session, {
    mode: "create",
    organizationSlug: "",
    name: "",
    region: "invalid region",
    publicUrl: "javascript:alert(1)",
    requestId: "",
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
});

test("setup returns an idempotent 202 snapshot, exposes authenticated polling, and maps active conflicts to 409", async () => {
  const safeSnapshot = {
    id: "job-one",
    status: "queued",
    stage: "queued",
    progress: { current: 0, total: 0, message: "Preparando la instalación." },
    error: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    statusUrl: "/api/jobs/job-one",
  };
  const requests = [];
  const origin = await startServer({
    async startSetupJob(input) {
      requests.push(input);
      if (input.requestId === "conflict-request") {
        const error = new Error("active");
        error.statusCode = 409;
        error.publicMessage = "Ya hay una configuración en curso.";
        throw error;
      }
      return safeSnapshot;
    },
    async getSetupJob(id) { return id === "job-one" ? safeSnapshot : null; },
  });
  const session = await openSession(origin);
  const body = { mode: "existing", ref: "abcdefghijklmnopqrst", publicUrl: "http://localhost:3000", requestId: "same-request" };

  const first = await postSetup(origin, session, body);
  const repeated = await postSetup(origin, session, body);
  assert.equal(first.status, 202);
  assert.equal(repeated.status, 202);
  assert.deepEqual((await first.json()).job, safeSnapshot);
  assert.deepEqual((await repeated.json()).job, safeSnapshot);
  assert.equal(requests.length, 2);

  const polled = await fetch(`${origin}/api/jobs/job-one`, { headers: { Cookie: session.cookie } });
  assert.equal(polled.status, 200);
  assert.deepEqual((await polled.json()).job, safeSnapshot);

  const conflict = await postSetup(origin, session, { ...body, requestId: "conflict-request" });
  assert.equal(conflict.status, 409);
});

test("Docker provisioning defaults its public site URL to host port 3300", async () => {
  const requests = [];
  const origin = await startServer({
    defaultPublicUrl: "http://localhost:3300",
    async startSetupJob(input) {
      requests.push(input);
      return { id: "job-default-url", status: "queued" };
    },
  });
  const session = await openSession(origin);

  const response = await postSetup(origin, session, {
    mode: "existing",
    ref: "abcdefghijklmnopqrst",
    requestId: "default-url-request",
  });

  assert.equal(response.status, 202);
  assert.equal(requests[0].publicUrl, "http://localhost:3300");
});

test("the Spanish page presents project choices and secret-free provisioning progress", async () => {
  const origin = await startServer({
    automaticCrmStart: true,
    defaultPublicUrl: "http://localhost:3300",
  });
  const html = await (await fetch(origin)).text();

  assert.match(html, /Usar un proyecto existente/u);
  assert.match(html, /Crear un proyecto nuevo/u);
  assert.match(html, /sa-east-1/u);
  assert.match(html, /clona tu fork/u);
  assert.match(html, /aplica las migraciones/u);
  assert.match(html, /configura Auth/u);
  assert.match(html, /crm\/.env\.local/u);
  assert.match(html, /arranca automáticamente/u);
  assert.match(html, /value="http:\/\/localhost:3300"/u);
  assert.match(html, /Docker va a iniciar el CRM en este mismo enlace: http:\/\/localhost:3300/u);
  assert.doesNotMatch(html, /Docker va a iniciar el CRM en este mismo enlace: http:\/\/localhost:3000/u);
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /service_role|SUPABASE_DB_PASSWORD/u);
});

test("local web mode does not claim Docker will start the CRM", async () => {
  const origin = await startServer();
  const html = await (await fetch(origin)).text();

  assert.match(html, /npm run levantar/u);
  assert.doesNotMatch(html, /Docker ya está construyendo/u);
});
