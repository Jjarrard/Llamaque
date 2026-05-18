# Harness Improvement Plan

This project already has the right shape: a pipeline, explicit stages, per-agent prompts, logs, a TTM parser, a surgical `Editor` agent, and objective compiler/test checks. The next jump is to make the harness less like "ask a model to rewrite a file" and more like a supervised coding loop: locate a small region, patch it, verify it, record what happened, repeat.

The goal is not to make small models smarter. It is to make each task simpler, narrower, and externally checkable so small models have fewer ways to get lost. Larger models still benefit because they waste fewer tokens and cannot silently overwrite unrelated code.

## Real Problems Today

1. **Whole-file rewrites are still the default for feedback.** The feedback pass sends the full file then asks the developer to output the complete updated file. Small models drop imports, forget handlers, or change unrelated UI. Even large models can make broad accidental edits.

2. **The feedback planner picks files, not regions.** It can say "edit `App.tsx`" but does not identify the symbol, JSX block, or line range. The next agent gets a vague file-level instruction.

3. **The `Editor` agent exists but is only used in iterative QA.** `runEditor` + `extractFileWindow` + `applyEdit` already form a Codex-style foundation. Feedback should use it.

4. **No semantic postcondition checks.** We validate syntax and sometimes tests, but not "did the model actually remove the thing the user asked to remove."

5. **Retry prompts are vague.** When a patch fails, the retry says "try harder" rather than feeding back the exact failed condition with line numbers.

6. **No structured "what's done / what's next" state.** Logs are chronological. There is no machine-readable ledger the UI can render as a clean timeline.

## Target Shape

Feedback becomes a deterministic loop with one or two LLM calls per iteration:

1. **Planner** (existing, slightly improved): produces a list of `{ filePath, instruction, targetHint }` edits from the user feedback.
2. **Locator** (mostly code, sometimes LLM): for each edit, find a bounded line window. Programmatic search first; only call a model if multiple candidates are ambiguous.
3. **Patch Editor** (`runEditor`, existing): edit one bounded region. Return `>>EDIT` or `>>NEEDS_WIDER_WINDOW`.
4. **Verifier** (programmatic): apply the patch to a copy, check syntax, check semantic postconditions, then commit.
5. **Ledger update** (code, not an agent): write a structured row describing what happened.

The "what's done / what's next" experience comes from the ledger, not from asking a model to think out loud. The harness already knows what it did — there is no reason to spend an LLM call summarizing state we have in memory.

## The Locator Step

This is the missing piece.

Input:

- The user's instruction for one file.
- File content with line numbers.
- Programmatic keyword hits (e.g. `signup`, `sign up`, `auth`, `login`, `register` for "remove signup").

Output:

```text
>>LOCATE
filePath: App.tsx
startLine: 18
endLine: 74
why: Contains "Sign up" heading, email/password inputs, handleSubmit.
>>END
```

Implementation:

1. Tokenize the instruction. Pull noun phrases ("signup screen", "submit button", "user list").
2. Run case-insensitive grep against the file for each phrase and common variants.
3. If exactly one cluster of hits exists, return that window without calling the model.
4. If multiple candidate windows exist, show the top three (each capped at ~80 lines) to the model and ask it to pick.
5. If no hits, fall back to the existing planner instruction and let the editor work on the whole file.

This deterministic-first approach is critical for small models. Most feedback hits an exact string somewhere in the file.

## The Editor Step

Use the existing `runEditor`. Tighten its system prompt:

```text
You may replace only lines START..END.
Do not include line numbers in replacement.
Do not edit unrelated behavior.
If the change requires lines outside this window, reply NEEDS_WIDER_WINDOW.
```

Add `NEEDS_WIDER_WINDOW` to the TTM protocol:

```text
>>NEEDS_WIDER_WINDOW
suggestedStartLine: 8
suggestedEndLine: 92
reason: signup state declared above window
>>END
```

The harness expands the window and retries once. If the editor still can't do it, fall through to whole-file rewrite as a last resort.

## The Verifier Step

All checks are deterministic. No LLM.

For every patch:

- The patch landed inside the requested line range.
- Syntax compiles (`checkTypeScriptSyntax` for ts/tsx/js/jsx).
- No abbreviation markers (`/* ... */`, `// rest unchanged`).
- File did not shrink by more than 60% unless the instruction was a removal.

Derive semantic postconditions from the instruction:

| Verb pattern    | Postcondition                                      |
| --------------- | -------------------------------------------------- |
| "remove X"      | X and common variants no longer appear in the file |
| "rename X to Y" | X absent, Y present                                |
| "add Z"         | Z (or close variant) present                       |
| "fix X"         | No automatic check — defer to syntax + manual      |

When a check fails, the retry prompt includes the exact evidence:

> The text "Sign up" still appears on line 42. Remove that UI and any now-unused state.

Not:

> Try again.

## Progress Ledger (Code-Owned)

A single JSON column on the project, written by the pipeline, never by an LLM:

```ts
feedbackLedger: text("feedback_ledger"),
```

Shape:

```json
{
  "goal": "Remove the signup screen",
  "items": [
    {
      "file": "App.tsx",
      "instruction": "Remove the signup form and auth gate",
      "status": "done",
      "window": { "startLine": 18, "endLine": 74 },
      "attempts": 1,
      "evidence": "TS syntax passed; 'Sign up' no longer present"
    },
    {
      "file": "App.tsx",
      "instruction": "Remove unused signup state",
      "status": "active",
      "attempts": 0
    }
  ]
}
```

The UI reads this and renders Done / Now / Next. The harness reads it on resume.

## Concrete Bugs To Fix

1. **Feedback uses developer whole-file output.** Route through `runEditor` first.
2. **Planner picks file, not region.** Add the Locator step.
3. **Vague retries.** Retry prompts must include verifier evidence with line numbers.
4. **No postcondition checks.** Derive checks from instruction verbs.
5. **No durable work state.** Add `feedbackLedger` JSON column.
6. **Patch trusts line numbers blindly.** Before applying, verify the snippet at startLine..endLine still matches what the editor saw. If the file changed, re-locate.
7. **No backup on line-patch failure.** The current feedback pass backs up before whole-file rewrite. Extend that to line patches too — store original content, restore on validation failure.

## What I Removed From The First Draft

These ideas were over-engineered or duplicated what already exists:

- **A separate "Navigator" LLM agent deciding what's next on every iteration.** The existing planner already lists edits up front. A code loop over that list is enough. Adding a second LLM call per step is slow on small models and pointless when state is already in the harness.
- **A "Progress Ledger" agent producing `>>LEDGER` blocks.** The pipeline knows what it just did. Maintaining state via an extra LLM call is waste. Ledger is a JSON column written by code.
- **Three-tier model size profiles with specific window/retry numbers.** Premature tuning. Start with one set of defaults; add a "big model" override only when measurements demand it.
- **A `workItems` relational table.** A single JSON column is enough until we need cross-project queries.
- **Renaming FBK log labels to NAV/LOC/EDT/VRF/LEDGER.** Pure churn. Logs already include the agent role.
- **`{before, after, diff}` patch records.** Existing `.bak` backup covers rollback.
- **Multi-hunk patches for large models.** Speculative; no current need.
- **Render/DOM/screenshot harness.** Out of scope.
- **Per-operation role tuning (locator low tokens, verifier tiny tokens).** The role config in `ollama.ts` is fine as-is; the locator and verifier are mostly code anyway.
- **`ASK_USER` / `ABORT` action types.** The pipeline already pauses and aborts via `this.aborted`.

## Implementation Order

### Phase 1 — Surgical feedback (highest value)

- Build the deterministic Locator (regex/keyword search, returns top window).
- Add `NEEDS_WIDER_WINDOW` to the TTM protocol.
- Rewrite `runFeedbackPass` to: plan → locate → `runEditor` → verify → commit. Whole-file rewrite only when locate fails or editor returns `NEEDS_WIDER_WINDOW` twice.
- Add snippet-hash check before `applyEdit`.

### Phase 2 — Postconditions

- Implement instruction-verb postcondition derivation.
- Wire failures back into retry prompts with exact line/text evidence.

### Phase 3 — Ledger

- Add `feedbackLedger` JSON column.
- Update after every locate / edit / verify step.
- Render Done / Now / Next in the project UI alongside `currentActivity`.

### Phase 4 — Optional escalation

- If a feedback iteration repeatedly fails verification, run a single LLM "what should I do next" call with the failure evidence. This is the only place a Navigator-style agent earns its keep — as an escape hatch, not the default path.

## First Code Change

Re-route `runFeedbackPass` through `runEditor`:

1. Existing planner picks `{ file, instruction }`.
2. New deterministic locator picks `{ startLine, endLine }` from keyword hits.
3. `runEditor` edits that window.
4. `applyEdit` + syntax check + postcondition check.
5. On failure: retry with evidence in the prompt.
6. On repeated failure: fall back to current whole-file path.

This single change addresses the dominant failure mode (whole-file rewrites trashing unrelated code) without inventing new agents or tables.

## Success Criteria

- Small models handle common feedback ("remove the signup screen", "rename the button", "delete the hero") with line patches, not full rewrites.
- Retry prompts cite exact evidence, not generic encouragement.
- Patches that exit their allowed window are rejected before write.
- UI shows Done / Now / Next from a structured ledger.
- Larger models still benefit but cannot silently overwrite unrelated code.
