import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { renderConnectionPage } from "../scripts/web/page.mjs";
import { validateSetupInput } from "../scripts/web/setup-input.mjs";

const createElement = ({ value = "" } = {}) => ({
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  },
  append() {},
  dataset: {},
  disabled: false,
  hidden: false,
  listeners: {},
  querySelector() { return null; },
  replaceChildren() {},
  required: false,
  scrollIntoView() {},
  textContent: "",
  value,
});

test("the generated page creates unique valid request IDs without crypto.randomUUID", async () => {
  const html = renderConnectionPage({ csrfToken: "csrf-test", nonce: "nonce-test" });
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  assert.doesNotMatch(script, /Math\.random/u);

  const connectionButton = createElement();
  const connectionForm = createElement();
  connectionForm.querySelector = () => connectionButton;
  const setupButton = createElement();
  const setupForm = createElement();
  setupForm.elements = { mode: { value: "existing" } };
  const setupResult = createElement();
  const existingSelect = createElement({ value: "abcdefghijklmnopqrst" });
  const elements = new Map([
    ['meta[name="csrf-token"]', { content: "csrf-test" }],
    ["#connection-form", connectionForm],
    ["#supabase-access-token", createElement()],
    ["#connection-result", createElement()],
    ["#setup-panel", createElement()],
    ["#setup-form", setupForm],
    ["#setup-result", setupResult],
    ["#setup-button", setupButton],
    ["#existing-project", existingSelect],
    ["#organization", createElement()],
    ["#public-url", createElement({ value: "http://192.168.9.45:3300" })],
  ]);

  let randomCalls = 0;
  const setupBodies = [];
  const context = {
    crypto: {
      getRandomValues(bytes) {
        randomCalls += 1;
        bytes.forEach((_, index) => { bytes[index] = index + randomCalls; });
        return bytes;
      },
    },
    document: {
      createElement: () => createElement(),
      querySelector: (selector) => elements.get(selector),
    },
    fetch: async (url, options) => {
      if (url === "/api/supabase/setup") {
        setupBodies.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ job: { statusUrl: "/api/jobs/test" } }) };
      }
      return {
        ok: true,
        json: async () => ({
          job: { status: "succeeded", progress: { message: "Complete" } },
        }),
      };
    },
    matchMedia: () => ({ matches: true }),
    setTimeout,
  };

  runInNewContext(script, context);
  const submit = setupForm.listeners.submit;
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await submit({ preventDefault() {} });

  assert.equal(randomCalls, 2);
  assert.equal(setupBodies.length, 2);
  assert.notEqual(setupBodies[0].requestId, setupBodies[1].requestId);
  for (const body of setupBodies) {
    assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(validateSetupInput(body).requestId, body.requestId);
  }

  context.crypto.getRandomValues = undefined;
  await submit({ preventDefault() {} });

  assert.equal(setupBodies.length, 2);
  assert.equal(setupResult.dataset.state, "error");
  assert.match(setupResult.textContent, /identificador seguro/u);
  assert.equal(setupButton.disabled, false);
});

test("Docker success retries the same origin until the installer yields to CRM", () => {
  const html = renderConnectionPage({
    automaticCrmStart: true,
    csrfToken: "csrf-test",
    defaultPublicUrl: "http://192.168.9.45:3300",
    nonce: "nonce-test",
  });
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/u)?.[1] || "";

  assert.match(script, /fetch\("\/healthz", \{ cache: "no-store" \}\)/u);
  assert.match(script, /headers\.get\("x-crm-installer"\) !== "1"/u);
  assert.match(script, /location\.assign\("\/login"\)/u);
  assert.doesNotMatch(script, /fetch\("http:\/\/192\.168\.9\.45:3300/u);
  assert.match(html, /Este mismo enlace está cambiando al CRM/u);
});
