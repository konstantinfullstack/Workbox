# ADR-006: Agent adapter contract

- **Status:** Accepted
- **Date:** 2026-11-05

## Decision

- Orchestration depends only on `#agents/contract.ts`:
  - `AgentAdapter.execute(task, emit, signal)` → `AgentResult`
  - neutral `AgentEvent` types (`started`, `progress`, `tool_call`, `log`); the orchestrator adds
    `stage`, `completed` and `failed`
  - cancellation via `AbortSignal`
  - `capabilities()` declares only what the adapter really supports
- Adapters never throw for agent failures; they return `failed` / `timed_out` / `cancelled` with
  a reason.
- The **agent's summary is a claim**, stored separately from verification results (spec §6,
  "evidence over claims").
- Instructions are built runtime-neutrally (`buildTaskInstructions`). The closing "Summary /
  Manual QA steps" format is parsed by `parseAgentReport`.
- **Claude Code adapter:** `claude -p --output-format stream-json --verbose --restricted …`.
  `system/init` → `started`, assistant text → `progress`, `tool_use` → `tool_call`,
  `result` → result (cost, turns, permission denials). The format was checked against the real CLI
  (v2.1.318).
- **Registry:** `createAgentRegistry()` maps `AgentRuntime` ids to adapters. A second runtime
  (M7) is added there and must pass the same contract tests.
- Nothing Claude-specific appears in the domain model, database schema, API or UI. The run row
  stores a neutral `agent` id.
