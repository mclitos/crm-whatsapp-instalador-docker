#!/usr/bin/env node

import { collectSupabaseDiagnostic } from "../lib/supabase-diagnostic.mjs";
import { EncryptedCredentialStore } from "../web/encrypted-store.mjs";

const diagnostic = await collectSupabaseDiagnostic({
  credentialStore: new EncryptedCredentialStore(),
});
process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
