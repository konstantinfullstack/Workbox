# ADR-005: Task state machine, history and audit guarantees

- **Status:** Accepted
- **Date:** 2026-11-04
- **Milestone:** M2 (outbox and event guarantees are extended in M6)

## Context

Spec §5 defines separate state machines for tasks, runs, PRs, verification, notifications and
connections, and forbids collapsing them into one status. Spec §6 and §11 require every state
transition to be recorded and auditable, and the backend to enforce which manual actions are
valid. M2 implements the task machine. The others follow in their milestones.

## Decision

1. **The task state machine is pure code** in `packages/core/src/domain/task-state-machine.ts`
   (`TASK_TRANSITIONS`). Approved table:

   | From                | To                                            |
   | ------------------- | --------------------------------------------- |
   | `backlog`           | planning, in_progress, blocked, cancelled     |
   | `planning`          | backlog, in_progress, blocked, cancelled      |
   | `in_progress`       | verification, blocked, cancelled              |
   | `verification`      | ready_for_qa, in_progress, blocked, cancelled |
   | `ready_for_qa`      | done, changes_requested, cancelled            |
   | `changes_requested` | in_progress, blocked, cancelled               |
   | `blocked`           | backlog, planning, in_progress, cancelled     |
   | `cancelled`         | backlog                                       |
   | `done`              | (terminal)                                    |

   Entering `blocked`, `changes_requested` or `cancelled` requires a reason.

2. **The server is the only authority.** The API returns `allowedTransitions` with every task.
   Clients render actions from that list and never re-derive the rules. The reason list
   (`TASK_STATES_REQUIRING_REASON`) is shared only for UX.
3. **One transaction per change.** A transition:
   - locks the task row (`SELECT … FOR NO KEY UPDATE`)
   - checks `expectedVersion`, if supplied
   - validates the transition
   - updates `state`, `version` and `state_changed_at`
   - inserts a `task_state_transitions` row and an `audit_logs` row (`task.state_changed`,
     with `trace_id` = request id)

   All of it commits together or not at all. Creation writes a history row with
   `from_state = NULL`.

4. **Optimistic concurrency.** `tasks.version` increments on every change. Clients send
   `expectedVersion`; a mismatch returns 409 `VERSION_CONFLICT` instead of silently overwriting.
   Without `expectedVersion`, concurrent transitions are still serialised by the row lock, and the
   second is validated against the state the first left behind.
5. **Lock ordering is project → task**, always. Task creation updates the project counter, which
   locks the project row first. Dependency edits explicitly lock the project before the task. This
   prevents deadlocks between dependency foreign-key checks and row locks.
   `FOR NO KEY UPDATE` is used because it doesn't block foreign-key `KEY SHARE` checks.
6. **Values are stored as `text` + CHECK constraints** generated from the same TypeScript lists,
   not Postgres enums, which are hard to evolve.
7. **Error mapping:** `INVALID_TRANSITION`, `REASON_REQUIRED` and `INVALID_DEPENDENCY` → 422;
   `VERSION_CONFLICT`, `SLUG_TAKEN` and `PROJECT_ARCHIVED` → 409; `NOT_FOUND` → 404.

## Not yet decided (future milestones)

- **Actor restrictions (M4):** some transitions (e.g. `in_progress → verification`) will become
  system-only, driven by the orchestrator. Every transition already records its `actor`.
- **Outbox (M6):** state changes will also emit `outbox_events` in the same transaction for
  notifications. The transaction boundary in `TaskService.transition` is where that goes.

## Consequences

- Changing the table means editing `TASK_TRANSITIONS`, the expected matrix in
  `packages/core/test/task-state-machine.test.ts` (all 81 pairs), and this ADR.
- History and audit can never disagree with the current state, because they're written atomically.
