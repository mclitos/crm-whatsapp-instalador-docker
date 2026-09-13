#!/usr/bin/env node

import { runCrmRuntime } from "./crm-runtime.mjs";

try {
  const result = await runCrmRuntime();
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
} catch (error) {
  console.error(`CRM: ${error.message || "no pudo iniciarse."}`);
  process.exitCode = 1;
}
