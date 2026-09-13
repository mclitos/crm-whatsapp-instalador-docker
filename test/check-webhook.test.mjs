import assert from "node:assert/strict";
import { test } from "node:test";

import { reportWebhookChallenge } from "../scripts/lib/check-webhook.mjs";

test("webhook 403 guidance never includes the verify token", () => {
  const verifyToken = "sentinel-secret-that-must-never-appear";
  const output = [];

  reportWebhookChallenge({
    body: "",
    challenge: "12345",
    responseOk: false,
    status: 403,
    verifyToken,
  }, {
    fail(message, action) { output.push(message, action); },
    ok(message, detail) { output.push(message, detail); },
  });

  assert.deepEqual(output, [
    "El webhook devuelve 403",
    "el verify token guardado en el CRM no coincide; revisá Settings → WhatsApp",
  ]);
  assert.equal(output.join("\n").includes(verifyToken), false);
});
