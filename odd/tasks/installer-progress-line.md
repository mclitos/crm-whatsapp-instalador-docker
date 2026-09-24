# Installer progress line

## Objective

Show a calm, truthful end-to-end installation path with five macro stages, an animated current stage, completed and pending states, migration counts, and a responsive vertical layout on small screens.

## Problem

The installer currently exposes only one changing status sentence. During long Supabase and build operations, people cannot tell what has completed, what is active, or what remains.

## Why

Visible progress reduces uncertainty and prevents users from restarting a healthy installation because it appears frozen.

## Scope

- Replace the plain setup status with a five-stage progress line: Account, Supabase, Database, CRM, Verification.
- Map existing backend stages to macro stages without inventing percentages.
- Show determinate progress only when `current` and `total` are available.
- Animate the active stage and respect reduced-motion preferences.
- Switch to a vertical layout on small screens.
- Preserve existing setup, error, retry, and Docker handoff behavior.

## Constraints

- No new npm dependencies.
- Keep technical artifacts in neutral professional Spanish, matching the existing UI.
- Do not expose secrets or alter Supabase provisioning semantics.
- Do not edit the cloned `crm/` workspace.
- Per-task size target is advisory; clarity, tests, and accessibility take priority.

## Authorized scope

- `scripts/web/page.mjs`
- Relevant tests under `test/`
- This feature document and its Engram mirror

## TDD and checks

- TDD mode: off/unknown; no explicit project or session TDD configuration was found.
- Test runner: `npm test`
- Additional checks: `git diff --check`; focused page rendering tests; browser structural/visual verification when practical.

## Delivery strategy

- Strategy: `ask-on-risk`
- Forecast: approximately 250–350 authored changed lines; expected to remain within one work-unit commit.
- Reviewed boundary: branch point `c4c7f58`.

## Tasks

- [x] **T1 — Implement the responsive installation progress line**
  - Route: delegated direct.
  - Trigger evidence: implementation prepares and changes multiple non-trivial concerns in the rendered page and its tests.
  - Acceptance: five macro stages render; backend stages map correctly; current/completed/pending/error states are accessible; migration progress is determinate only with real totals; reduced motion and mobile layout work; existing polling and handoff remain intact.
  - Checks: focused tests, `npm test`, `git diff --check`.
  - Evidence:
    - Route: delegated direct implementation on `feat/installer-progress-line`.
    - Files: `scripts/web/page.mjs`, `test/web-page.test.mjs`, `odd/tasks/installer-progress-line.md`.
    - Behavior: five semantic macro stages, truthful determinate migration progress, indeterminate external waits, accessible active/error/completed states, responsive vertical path, and reduced-motion handling.
    - Rationale: map existing backend events into a monotonic macro path and reveal numeric progress only for valid integer `current`/`total` pairs; provisioning and handoff behavior remain unchanged.
    - Checks: `node --test test/web-page.test.mjs` — 5 passed; `npm test` — 131 passed; `git diff --check` — passed with no output.
    - Runtime harness: N/A; the focused rendered-page test executes the embedded client script without starting Docker, Supabase, remote services, or the live CRM.
    - Rollback boundary: remove the progress markup/styles/client renderer and its focused assertions from the three files above.
    - Commit: `ec7ed1d` (`feat(installer): add staged setup progress`).
    - Native assessment: medium risk, `review_due: false`, reason `under_budget` for the range from `c4c7f58`.

- [x] **T2 — Refresh the README for the current installer experience**
  - Route: delegated direct.
  - Trigger evidence: understanding and rewriting the primary onboarding document requires preparation against the current scripts, Docker flow, progress experience, and repository identity.
  - Acceptance: README leads with the no-terminal Docker path, accurately reflects the current Supabase-backed architecture and automated flow, explains the new visual progress experience, preserves security and recovery warnings, remains easy to scan, and does not claim unimplemented behavior.
  - Checks: repository link and command verification, `npm test`, `git diff --check`.
  - Evidence:
    - Route: delegated direct documentation work on `docs/readme-current-installer`.
    - Files: `README.md`, `odd/tasks/installer-progress-line.md`.
    - Rationale: lead with the no-terminal Docker outcome, reveal architecture and advanced commands progressively, and keep operational claims tied to the current Compose and npm scripts.
    - Content: documents the temporary installer-to-CRM handoff on port 3300, named-volume persistence, external Supabase backend, five-stage progress path, automated and owner-only actions, repository identities, recovery commands, and safety boundaries.
    - Focused check: README local-link and npm-script verifier — 5 local paths and 10 npm scripts verified.
    - Full check: `npm test` — 131 passed, 0 failed.
    - Formatting check: `git diff --check` — passed with no output.
    - Runtime harness: N/A; this work unit changes documentation only, while the full test suite validates README-coupled runtime metadata.
    - Rollback boundary: revert `README.md` and the T2 evidence in this task document without affecting the installer implementation.

## Progress

- Feature branch created: `feat/installer-progress-line`.
- T1 completed and verified in `ec7ed1d`; focused parent spot check also passed 5/5.
- T2 completed and verified on `docs/readme-current-installer`; GitHub publication remains outside this task.

## Next step

Review the T2 work-unit commit and choose the later publication step separately.
