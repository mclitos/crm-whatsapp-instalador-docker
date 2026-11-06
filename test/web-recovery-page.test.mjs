import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { renderConnectionPage } from "../scripts/web/page.mjs";

const element = ({ value = "" } = {}) => ({
  addEventListener(type, listener) { this.listeners[type] = listener; },
  append(option) { this.options.push(option); this.children.push(option); },
  dataset: {},
  disabled: false,
  hidden: false,
  listeners: {},
  options: [],
  children: [],
  querySelector() { return null; },
  focus() {},
  removeAttribute() {},
  replaceChildren() { this.options = []; this.children = []; },
  required: false,
  scrollIntoView() {},
  setAttribute() {},
  style: {},
  textContent: "",
  value,
});

const createHarness = (fetch) => {
  const selectors = [
    'meta[name="csrf-token"]', "#connection-form", "#supabase-access-token", "#connection-result",
    "#setup-panel", "#setup-form", "#setup-result", "#setup-button", ".progress-frame",
    "#progress-detail", "#progress-meter", "#progress-meter-fill", "#progress-count", "#existing-project",
    "#organization", "#public-url", "#supabase-project-ref", "#existing-fields", "#create-fields",
    "#project-name", "#region", "#attention-panel", "#attention-list", "#recovery-form",
    "#recovery-existing", "#recovery-existing-fields", "#recovery-ref", "#recovery-not-created", "#recovery-confirm",
    "#recovery-result", "#recovery-submit",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  elements.get('meta[name="csrf-token"]').content = "csrf-test";
  const connection = elements.get("#connection-form");
  connection.querySelector = () => element();
  const setup = elements.get("#setup-form");
  setup.elements = { mode: { value: "existing" } };
  const recovery = elements.get("#recovery-form");
  recovery.elements = { decision: { value: "existing" } };
  const context = {
    crypto: { randomUUID: () => "fresh-request-id" },
    document: {
      createElement: () => element(),
      querySelector: (selector) => elements.get(selector),
      querySelectorAll: () => [],
    },
    fetch,
    matchMedia: () => ({ matches: true }),
    setTimeout: async () => {},
  };
  runInNewContext(renderConnectionPage({ csrfToken: "csrf-test", nonce: "nonce-test" }).match(/<script[^>]*>([\s\S]*?)<\/script>/u)[1], context);
  return { elements, context };
};

test("ambiguous project recovery is explicit, safe, and persists across page load", async () => {
  const requests = [];
  let resolved = false;
  const harness = createHarness(async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "/api/supabase/connect") return { ok: true, json: async () => ({ message: "Conexión validada" }) };
    if (url === "/api/supabase/options") return { ok: true, json: async () => ({ projects: [{ ref: "abcdefghijklmnopqrst", name: "Mi proyecto", region: "sa-east-1", status: "ACTIVE_HEALTHY" }], organizations: [] }) };
    if (url === "/api/jobs/attention") return { ok: true, json: async () => ({ ok: true, jobs: resolved ? [] : [{ id: "opaque-job-123", status: "needs_attention", stage: "needs_attention", error: { code: "project_creation_ambiguous", message: "mensaje <img src=x>" } }] }) };
    if (url === "/api/jobs/opaque-job-123/resolve") { resolved = true; return { ok: true, json: async () => ({ ok: true, job: { id: "opaque-job-123" }, resolution: { decision: "existing", ref: "zyxwvutsrqponmlkjihg" } }) }; }
    throw new Error(`Unexpected request: ${url}`);
  });
  const { elements } = harness;
  const submitConnection = elements.get("#connection-form").listeners.submit;
  await submitConnection({ preventDefault() {} });

  assert.ok(requests.some(({ url }) => url === "/api/jobs/attention"), `load unresolved jobs after options; requests=${requests.map(({ url }) => url).join(",")}; error=${elements.get("#connection-result").textContent}`);
  assert.equal(elements.get("#attention-panel").hidden, false);
  assert.equal(elements.get("#attention-list").children[0].textContent.includes("opaque-job-123"), true);
  assert.equal(elements.get("#attention-list").children[0].textContent.includes("<img"), false, "untrusted server strings stay out of HTML");
  assert.equal(elements.get("#recovery-ref").options.length, 1, "recovery project choices come from fetched options");
  assert.match(renderConnectionPage({ csrfToken: "csrf-test", nonce: "nonce-test" }), /Confirmo que revisé el panel de Supabase/u);

  const confirm = elements.get("#recovery-confirm");
  const recoveryForm = elements.get("#recovery-form");
  const recoverySubmit = elements.get("#recovery-submit");
  const refSelect = elements.get("#recovery-ref");
  assert.equal(recoverySubmit.disabled, true, "fresh confirmation gates submit");
  await recoveryForm.listeners.submit({ preventDefault() {} });
  assert.equal(requests.some(({ url }) => url.endsWith("/resolve")), false, "unchecked confirmation cannot resolve a job");
  elements.get("#setup-form").elements.mode.value = "create";
  confirm.checked = true;
  refSelect.value = "zyxwvutsrqponmlkjihg";
  recoveryForm.elements = { decision: { value: "existing" } };
  await recoveryForm.listeners.submit({ preventDefault() {} });
  assert.equal(requests.some(({ url }) => url === "/api/supabase/setup"), false, "recovery must not auto-submit setup");
  const resolveRequest = requests.find(({ url }) => url.endsWith("/resolve"));
  assert.equal(resolveRequest.url, "/api/jobs/opaque-job-123/resolve");
  assert.equal(resolveRequest.options.method, "POST");
  assert.equal(resolveRequest.options.headers["X-CSRF-Token"], "csrf-test");
  assert.deepEqual(JSON.parse(resolveRequest.options.body), { decision: "existing", ref: "zyxwvutsrqponmlkjihg", confirmed: true });
  assert.equal(elements.get("#setup-form").elements.mode.value, "existing");
  assert.equal(elements.get("#existing-project").value, "zyxwvutsrqponmlkjihg", "select returned ref even when options were stale");
  assert.match(elements.get("#recovery-result").textContent, /presioná el botón de configuración/u);
  assert.equal(elements.get("#attention-panel").hidden, true);
  assert.match(elements.get("#setup-result").textContent, /presioná el botón de configuración/u,
    "success remains visible outside the hidden recovery panel");
});

test("resolving one of several jobs restores the next job's visible required project selector", async () => {
  let resolved = false;
  const posts = [];
  const harness = createHarness(async (url, options = {}) => {
    if (options.method === "POST") posts.push(url);
    if (url === "/api/supabase/connect") return { ok: true, json: async () => ({ message: "Conectado" }) };
    if (url === "/api/supabase/options") return { ok: true, json: async () => ({ projects: [{ ref: "abcdefghijklmnopqrst", name: "CRM" }], organizations: [] }) };
    if (url === "/api/jobs/attention") return { ok: true, json: async () => ({ jobs: [
      ...(!resolved ? [{ id: "job-first", status: "needs_attention", error: { code: "project_creation_ambiguous" } }] : []),
      { id: "job-second", status: "needs_attention", error: { code: "project_creation_ambiguous" } },
    ] }) };
    if (url === "/api/jobs/job-first/resolve") {
      resolved = true;
      return { ok: true, json: async () => ({ resolution: { decision: "not_created" } }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const { elements } = harness;
  await elements.get("#connection-form").listeners.submit({ preventDefault() {} });
  const form = elements.get("#recovery-form");
  form.elements.decision.value = "not_created";
  form.listeners.change({ target: { name: "decision" } });
  assert.equal(elements.get("#recovery-existing-fields").hidden, true);
  elements.get("#recovery-confirm").checked = true;

  await form.listeners.submit({ preventDefault() {} });

  assert.equal(form.elements.decision.value, "existing");
  assert.equal(elements.get("#recovery-existing-fields").hidden, false);
  assert.equal(elements.get("#recovery-ref").required, true);
  assert.equal(elements.get("#recovery-confirm").checked, false);
  assert.equal(elements.get("#recovery-submit").disabled, true);
  assert.match(elements.get("#attention-list").children[0].textContent, /job-second/u);
  assert.equal(posts.includes("/api/supabase/setup"), false);
});

test("recovery decision changes reset confirmation and failed recovery remains actionable", async () => {
  const requests = [];
  const harness = createHarness(async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "/api/supabase/connect") return { ok: true, json: async () => ({ message: "Conexión validada" }) };
    if (url === "/api/supabase/options") return { ok: true, json: async () => ({ projects: [], organizations: [] }) };
    if (url === "/api/jobs/attention") return { ok: true, json: async () => ({ ok: true, jobs: [{ id: "job-2", status: "needs_attention", error: { code: "project_creation_ambiguous" } }] }) };
    if (url.endsWith("/resolve")) return { ok: false, status: 409, json: async () => ({ message: "Todavía no se puede resolver." }) };
    throw new Error(`Unexpected request: ${url}`);
  });
  const { elements } = harness;
  await elements.get("#connection-form").listeners.submit({ preventDefault() {} });
  const confirm = elements.get("#recovery-confirm");
  const recoveryForm = elements.get("#recovery-form");
  confirm.checked = true;
  recoveryForm.elements.decision.value = "not_created";
  recoveryForm.listeners.change({ target: { name: "decision" } });
  assert.equal(confirm.checked, false);
  confirm.checked = true;
  recoveryForm.elements = { decision: { value: "not_created" } };
  await recoveryForm.listeners.submit({ preventDefault() {} });
  const request = requests.find(({ url }) => url.endsWith("/resolve"));
  assert.deepEqual(JSON.parse(request.options.body), { decision: "not_created", confirmed: true });
  assert.equal(elements.get("#attention-panel").hidden, false, "failed resolution stays available");
  assert.match(elements.get("#recovery-result").textContent, /Todavía no se puede resolver/u);
});
