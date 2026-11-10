# M5 — Git Workflow and Verification

- **Status:** approved 2026-11-10. Steps 1 and 2 implemented.
- **Spec reference:** §12 M5 (branch/commit/push/PR, checks, test summary, artifacts, QA
  instructions, dashboard Git references)
- **Already delivered in M4 B2:** branch per task, commit as the user, push, draft PR/MR, configured
  checks with one retry, QA steps, PR state on the task page.

## Decisions (user, 2026-11-10)

- PR/MR **merged** → task **Done**; **closed without merging** → **Changes requested**.
- Run artifacts are kept **7 days**.
- Real test repository: `1_64_modelcollector` (GitHub). The GitLab run needs a GitLab repository,
  chosen at step 5.

## Steps

1. **Tasks follow their pull request** ✅
   - the worker checks open PRs/MRs every 3 minutes (and once at startup); opening the task page
     checks too
   - only tasks in Ready for QA are moved; history actor `system:review-sync`, reason e.g. "Pull
     request #3 was merged on GitHub"
   - merged task branches are removed from the working copy, only when safe: a `workbox/` branch,
     not checked out, tip equal to what was pushed (`git_references.local_branch_removed_at`)
   - Continue development doesn't re-run a task whose PR you closed; it stops and says so
2. **Run artifacts** ✅
   - per run, in `<workbox>/artifacts/<runId>/` (git-ignored; `WORKBOX_ARTIFACTS_DIR`):
     `agent-transcript.jsonl` (the adapter's raw output, every pass), `checks/<pass>-<step>-<name>.log`
     (complete output), `branch.patch` (`git format-patch`, applies with `git am`)
   - indexed in `run_artifacts`; shown under **Saved files** on the run (view as plain text or
     download)
   - deleted after `WORKBOX_ARTIFACT_RETENTION_DAYS` (default 7) by the worker, hourly
   - saving is best effort: a problem is a warning on the timeline, never a failed run
3. **Links and summaries:** commit and branch links to the host; a one-line result per check (e.g.
   "42 passed, 1 failed") on the run and in the PR body.
4. **Failures never look like success:** Playwright end-to-end tests against fake GitHub and git
   servers: success, checks fail, push rejected, PR creation fails.
5. **GitLab for real:** one run on a GitLab repository (merge request).

## Acceptance (spec)

From a task: create a branch, implement the change, pass checks, open a PR, and show PR, commit and
artifact links. Failures are visible and never reported as success.
