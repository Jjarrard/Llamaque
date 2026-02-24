# Small-Model Execution Plan (Tools-First)

## Why this rewrite

Current behavior still relies on small models to do too much in one step (especially full `script.js` synthesis), which causes:

- duplicate declarations
- repeated/overlapping logic
- weak cross-file consistency
- retry loops that burn tokens without converging

The strategy below shifts complexity from LLM reasoning into deterministic tools.

Scope target: this must support any app that can be built with vanilla HTML, CSS, and JavaScript (forms, dashboards, games, calculators, planners, content tools, etc.).

## Target architecture

1. **LLM plans intent, not code**
   - Agents output constrained JSON actions (what to add/change), not full files.
2. **Deterministic tools apply edits**
   - Idempotent operations update HTML/CSS/JS safely.
3. **Manifest as source of truth**
   - Keep a machine-readable project manifest (ids, classes, handlers, state vars).
4. **Validation becomes structural first**
   - Verify manifest/code consistency before style/quality checks.

## Phases

### Phase 1 — Stabilize current pipeline (in progress)

- Reduce per-file requirement pressure (especially `script.js`).
- Tighten retry prompts to prevent duplicate declarations.
- Ensure HTML contract always exists before CSS/JS generation.
- Keep current flow intact while lowering failure rate.

### Phase 2 — Introduce operation schema

Add a strict operation model:

- `ensureHtmlNode`
- `ensureCssRule`
- `ensureJsFunction`
- `ensureEventBinding`
- `ensureStateVariable`

Plus generic, domain-agnostic UI/data operations:

- `ensureInput`
- `ensureButton`
- `ensureList`
- `ensureTextBlock`
- `ensureRenderFunction`
- `ensureActionHandler`
- `ensureDerivedComputation`

Rules:

- Idempotent by design.
- No operation may create duplicate symbol names.
- Operations must validate against manifest before write.

### Phase 3 — Operation executor (tools layer)

- Build deterministic executors for HTML/CSS/JS operations.
- Apply operations to files in ordered passes:
  1. HTML structure
  2. CSS rules
  3. JS state/functions/events
- Keep whole-file Developer generation as fallback only.

### Phase 4 — Pipeline integration

- Replace direct feature→file prompts with feature→ops compilation.
- Run executor first; only unresolved ops call Developer.
- Persist op execution logs for debugging/replay.

### Phase 5 — Manifest-driven QA

- Check every referenced id/class/function exists.
- Check duplicate symbols structurally, not regex-only.
- Fail fast with precise, machine-actionable repair reason.

### Phase 6 — Metrics and tuning

Track per project:

- parse failure rate
- retry count per file
- stuck reasons histogram
- fallback-to-Developer frequency

Use metrics to tune caps and prompts by model size.

## Immediate implementation started

This work starts now with Phase 1 hardening:

- per-file requirement caps (smaller cap for `script.js`)
- stronger anti-duplication guidance in JS generation prompts

## Success criteria

- `script.js` duplicate-declaration STUCK rate reduced by >70%
- average retries per file < 1.2
- majority of arbitrary vanilla web apps finish without manual intervention
