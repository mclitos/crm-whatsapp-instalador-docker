import assert from "node:assert/strict";
import { test } from "node:test";

import { validateSetupInput } from "../scripts/web/setup-input.mjs";

const inputFor = (publicUrl) => ({
  mode: "existing",
  publicUrl,
  ref: "abcdefghijklmnopqrst",
  requestId: "private-url-request",
});

test("setup accepts HTTPS and HTTP only for loopback or RFC1918 hosts", () => {
  for (const publicUrl of [
    "http://localhost:3300",
    "http://127.0.0.2:3300",
    "http://[::1]:3300",
    "http://10.0.0.1:3300",
    "http://10.255.255.254:3300",
    "http://172.16.0.1:3300",
    "http://172.31.255.254:3300",
    "http://192.168.0.1:3300",
    "http://192.168.255.254:3300",
    "https://crm.example.com",
  ]) {
    assert.equal(validateSetupInput(inputFor(publicUrl)).publicUrl, publicUrl);
  }
});

test("setup rejects HTTP for public, link-local, and out-of-range private addresses", () => {
  for (const publicUrl of [
    "http://example.com:3300",
    "http://8.8.8.8:3300",
    "http://11.0.0.1:3300",
    "http://169.254.1.1:3300",
    "http://172.15.255.255:3300",
    "http://172.32.0.1:3300",
    "http://192.167.255.255:3300",
    "http://192.169.0.1:3300",
    "http://192.168.9.999:3300",
  ]) {
    assert.throws(() => validateSetupInput(inputFor(publicUrl)), /HTTPS|URL pública/u);
  }
});
