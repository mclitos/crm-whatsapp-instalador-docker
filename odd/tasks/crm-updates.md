# CRM updates

## Objective

Let an installed CRM follow reviewed upstream wacrm releases with one command, `npm run actualizar -- --docker`, and return to a previous version when needed, without losing data or the `ENCRYPTION_KEY`.

## Problem

`CrmWorkspace.ensure()` skips any valid checkout and clones with `--depth 1`, so rerunning the installer never brings new CRM code. There is no pinned, reviewed CRM version, no way to see the installed version, and no documented rollback.

## Why

Installs age while wacrm keeps shipping fixes. People who do not program need a safe, single-step update that refuses to run risky migrations silently.

## Scope

- Pin the reviewed CRM version in a tracked `crm-version.json` (`repo` + full `commit`) using `ArnasDon/wacrm` directly, so the fork no longer needs manual syncing.
- New installs clone exactly the pinned commit; `CRM_REPO_URL` keeps overriding the source (then it follows that repo's default branch, as today).
- A container-side updater that compares versions, refuses local code changes (ignoring installer markers), fetches the target commit, detects pending migrations, requires explicit confirmation before applying them, checks out, applies pending migrations, and refreshes the readiness marker.
- `--commit <hash>` to move to any commit, including a rollback.
- Host command `npm run actualizar -- --docker` that pulls the installer, rebuilds the image, runs the updater, restarts the CRM, and waits for health.
- `npm run check` shows the installed version and whether a newer pinned version exists.
- Docs: `docs/06-actualizaciones.md` (including how to go back to a previous version) and a README pointer.

## Constraints

- Zero npm dependencies; Node 20 built-ins only.
- Never `git clean`, never `docker compose down -v`, never rotate `ENCRYPTION_KEY`, never touch `.env.local` contents.
- Do not invent Supabase endpoints; no automatic backup unless a verified endpoint exists. Pending migrations stop the update until the person confirms with `--aplicar-migraciones`.
- Errors in Spanish and actionable (`fail(qué, cómo se arregla)` pattern); never print secrets.
- Idempotent: rerunning with the same version does nothing.
- Technical artifacts follow the existing repo language (Spanish user-facing strings and docs).

## Authorized scope

- `crm-version.json`, `scripts/lib/crm-source.mjs`, `scripts/lib/crm-workspace.mjs`, `scripts/lib/supabase-setup.mjs` (export migration application), new `scripts/lib/crm-update.mjs`, new `scripts/container/update-crm.mjs`, new `scripts/actualizar.mjs`, `scripts/check.mjs` / `scripts/lib/check-workspace.mjs`, `compose.yaml`, `package.json`, `Dockerfile` (only if the version file must be copied), `.env.example`, `README.md`, `CLAUDE.md` (source identity lines), `docs/06-actualizaciones.md`, tests under `test/`, this document.

## TDD and checks

- TDD mode: off (source: no project or session TDD configuration; same as previous feature).
- Test runner: `npm test` (`node --test test/*.test.mjs`).
- Additional checks: `git diff --check`; `docker compose config`; dry-run of the updater against the live install when practical.

## Delivery strategy

- Strategy: `single-pr` (single-maintainer repository; history lands on `main`).
- Forecast: approximately 700–900 authored changed lines across four work-unit commits.
- RDD: off (global), so no review assessment runs; delivery is `disabled/unmanaged`.
- Branch: `feat/crm-updates` from `b5e3277`.

## Tasks

- [x] **T1 — Pin the CRM version and clone it on install**
  - Route: delegated direct (writer trigger: 2+ non-trivial files).
  - Acceptance: `crm-version.json` pins `45e80ad9e23b91f5c02ab9f935edbae67810e59d` from `https://github.com/ArnasDon/wacrm.git`; source resolution returns `{ repoUrl, commit }`; fresh clone checks out the pinned commit; `CRM_REPO_URL` override still works; compose no longer hardcodes the fork as a default.
  - Checks: focused tests, `npm test`, `git diff --check`, `docker compose config -q`.
  - Evidence: commit `457cd55`; files `crm-version.json`, `scripts/lib/crm-source.mjs`, `scripts/lib/crm-workspace.mjs`, `scripts/lib/supabase-setup.mjs`, `scripts/web/setup-job.mjs`, `scripts/paso1-supabase.mjs`, `compose.yaml`, `.env.example`, `README.md`, `CLAUDE.md`, `LICENSE`, `docs/03-deploy.md`, tests. `npm test`: 138 pass, 0 fail; `git diff --check`: clean; `docker compose config -q`: ok.
- [x] **T2 — Container updater with migration gate and rollback**
  - Route: delegated direct.
  - Acceptance: same version → no-op; local tracked changes → stop; markers ignored; pending migrations without `--aplicar-migraciones` → stop with explanation and no checkout; with it → checkout, apply pending only, mark ready; `--commit` allows any commit and warns that migrations are not reverted on rollback; previous commit printed.
  - Checks: focused tests with fake git runner and Supabase admin, `npm test`.
  - Evidence: commit recorded in the following commit log entry (see `git log -- scripts/lib/crm-update.mjs`); files `scripts/lib/crm-update.mjs`, `scripts/container/update-crm.mjs`, `scripts/lib/supabase-setup.mjs` (export `applyMigrations`), `compose.yaml` (`updater`, profile `update`), `Dockerfile` (copies `crm-version.json`), `test/crm-update.test.mjs`. `npm test`: 151 pass, 0 fail; `docker compose config -q`: ok.
- [x] **T3 — Host command and version in `npm run check`**
  - Route: delegated direct.
  - Acceptance: `npm run actualizar -- --docker` pulls installer (`--ff-only`, refuses dirty tree), rebuilds image, runs updater, restarts `crm`, waits for health, reports downtime expectation; `npm run check` shows installed vs pinned version.
  - Checks: `npm test`, `git diff --check`, real run against the live install.
  - Evidence: commit recorded in `git log -- scripts/actualizar.mjs`; files `scripts/actualizar.mjs`, `scripts/lib/actualizar-docker.mjs`, `scripts/lib/check-workspace.mjs` (probe reads HEAD; `reportCrmVersion`), `scripts/check.mjs`, `package.json`, `test/actualizar-docker.test.mjs`, `test/check-workspace.test.mjs`. `npm test`: 160 pass, 0 fail; `git diff --check`: clean; `npm run check` (read-only, live install) prints "CRM en la versión 45e80ad9e23b ... es la versión revisada"; `node scripts/actualizar.mjs` without `--docker` gives the actionable message. Real update run: pending, done by the parent.
- [x] **T4 — Documentation including rollback**
  - Route: delegated direct.
  - Acceptance: `docs/06-actualizaciones.md` describes the implemented behavior (status note removed) with a "Volver a una versión anterior" section; README points to it.
  - Checks: structural readback, `git diff --check`.
  - Evidence: commit recorded in `git log -- docs/06-actualizaciones.md`; files `docs/06-actualizaciones.md`, `README.md`. Readback: status note removed, new "Volver a una versión anterior" section, README docs table links the guide; `npm test`: 160 pass, 0 fail; `git diff --check`: clean.

## Progress

- T2 reopened after independent verification, reason: (1) rerunning after an interruption post-checkout returned `unchanged` and never applied migrations; (2) fetch used `origin`, which is the fork on existing installs; (3) `CRM_REPO_URL` installs would silently move to the pinned upstream commit. Fixed in `fix(crm): make interrupted updates resumable`: same-revision runs still compare migrations and the readiness marker and report `updated` when work remained; fetch uses the explicit repo URL (`CRM_REPO_URL` via compose `${CRM_REPO_URL:-}` or `crm-version.json`); custom sources require `--commit`. Docs updated. `npm test`: 166 pass, 0 fail; `git diff --check`: clean; `docker compose config -q`: ok.

- Pre-implementation: dry run and real manual update of the live install from `80c3f9a` to `45e80ad` succeeded (≈3 min downtime, 0 migrations, data intact).

- Live run (parent, 2026-09-28): `npm run actualizar -- --docker --sin-pull` rebuilt images, the updater read Supabase applied migrations through the encrypted `/data` credentials, and reported `unchanged` at `45e80ad`; no restart, CRM stayed `healthy`. `npm run check` prints "CRM en la versión 45e80ad9e23b es la versión revisada de este instalador". Known minor UX: the "apagado unos 3 minutos" notice prints before knowing whether an update is needed. Rollback path (`--commit <older>`) covered by tests but not yet exercised live.

- Live rollback (parent, 2026-09-28): first attempt with `--commit` failed safely (`node: bad option: --commit`, CRM untouched) because `docker compose run updater <args>` replaces the service command; the unit test had asserted that shape. Fixed in `677f050` (`fix(actualizar): pass updater entrypoint when forwarding flags`), `npm test` 166 pass. Retry: `45e80ad` -> `80c3f9a` in ~2.5 min with the rollback warning, 0 migrations, `healthy`; forward again `80c3f9a` -> `45e80ad` with no flags, `healthy`; `npm run check`: version is the reviewed one, 37 tables, 42 migrations, ENCRYPTION_KEY present.
- Known follow-ups: the success line hardcodes `http://127.0.0.1:3300` and ignores `HOST_BIND_ADDRESS` (same pre-existing issue as `levantar.mjs`); the downtime notice prints even when nothing changes.

## Next step

Merge `feat/crm-updates` into `main` when the user decides.
