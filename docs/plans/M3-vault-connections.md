# M3 plan: Credential vault, accounts and repositories

- **Status:** Approved (revision 2) and implemented 2026-11-04; see docs/PROGRESS.md
- **Spec reference:** §8 Connection Manager and Credential Vault, §10 integrations, §11 security,
  §12 M3
- **Depends on:** M1, M2

## Goal

Securely link every project to its repository, on **GitHub or GitLab**, under **any account**
(personal, organisation, self-hosted), and confirm Claude Code is available on this machine. This
is everything M4 needs to run an agent and M5 needs to push and open pull/merge requests.

## Scope

**In:**

- Encrypted credential vault and ADR-003 (vault and master key lifecycle)
- **Accounts** (connections): one token for one account on one provider and host, reusable across
  projects
- Provider-agnostic **code-host interface** with **GitHub and GitLab** adapters (gitlab.com and
  self-hosted; github.com, and GitHub Enterprise via base URL)
- Project ↔ repository link stored as structured provider data, with access verification
- Repository setup **inside the project form**, including adding an account inline
- Connections page for managing accounts in one place
- Claude Code availability check, run by the worker

**Out:**

- CLI: after M4 (user decision)
- GitHub App / GitLab OAuth sign-in: later; the account layer allows adding them
- Telegram: M6
- **Writing to repositories** (branches, pushes, PRs/MRs): M5. **M3 only reads.**

**Change from spec §12:** the M3 acceptance criterion "from CLI and dashboard" becomes "from the
dashboard".

## Decisions

| #   | Decision                                                                                                                  | Source |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| U1  | Tokens first: GitHub fine-grained token; GitLab access token. App/OAuth sign-in later                                     | user   |
| U2  | Autopilot stops at Ready for QA for a manual check (M4/M6)                                                                | user   |
| U3  | CLI deferred until after M4                                                                                               | user   |
| U4  | "Continue development" arrives in M4 as "run the next eligible task, stop at QA"                                          | user   |
| U5  | **GitLab is in scope** for M3, alongside GitHub                                                                           | user   |
| U6  | Repository is set up in the project form (with inline "add account"); the Connections page also manages accounts          | user   |
| D1  | **One repository per project** for now; the schema allows more later (`purpose` column)                                   | me     |
| D2  | **A repository belongs to at most one Workbox project**, so two projects never write to the same repo                     | me     |
| D3  | Tokens are stored **per account**, not per project. One token can serve many projects; a narrow token per repo also works | me     |
| D4  | The master key lives in `.env` (`WORKBOX_MASTER_KEY`); the OS keychain is optional later                                  | me     |

**Why D1:** one repo means one worktree, branch and PR per task. Changes spanning repos would need
coordinated branches, PRs and verification across them, which is a later milestone. Until then,
split repos can be separate Workbox projects.

## Data model: accounts vs repositories

```text
Account (connection) = one token, one account, one provider + host
  "GitHub – kost"        github     https://api.github.com
  "GitHub – leadoo org"  github     https://api.github.com
  "GitLab – kost"        gitlab     https://gitlab.com
  "GitLab – company"     gitlab     https://gitlab.company.com

Project ──(primary repository)──▶ Repository ──(accessed via)──▶ Account
```

A GitHub fine-grained token belongs to **one owner** (your user or one organisation). Repos under
different owners therefore need separate accounts. GitLab project and group access tokens are
similarly limited to one project or group.

## Security model

1. **Encryption at rest:** AES-256-GCM (`node:crypto`), with a random 12-byte IV and an
   authentication tag per secret. The credential id + provider are bound in as associated data, so
   encrypted blobs can't be swapped between rows.
2. **Master key outside the database:** `WORKBOX_MASTER_KEY` (32 random bytes, base64) in `.env`.
   - Generated with `pnpm vault:generate-key`.
   - `.env.example` leaves it empty; a committed example key would be a real key.
   - Missing or malformed key → the API refuses to start, with a clear message.
3. **Key rotation:** every ciphertext stores a `key_version`. `WORKBOX_PREVIOUS_MASTER_KEYS` keeps
   old keys readable, and `pnpm vault:rotate` re-encrypts everything with the current key.
4. **Secrets never come back out:**
   - The API accepts a token once and returns only a fingerprint (`github_pat_…a1B2`,
     `glpat-…x9Yz`).
   - Decrypted values are wrapped in a `Secret` type that prints `[REDACTED]` when converted to a
     string, to JSON or inspected.
   - Log redaction covers token fields and auth headers.
   - Tests inspect the raw DB row, API responses and captured logs for the token.
5. **The agent never sees any token.** From M5, Workbox itself pushes and opens PRs/MRs. The Claude
   Code sandbox (M4) only gets the worktree.
6. **Every decryption is audited** (`credential.accessed`, with purpose and trace id), as are
   account created, tested, rotated and disconnected, and repository linked, verified and unlinked.
7. **Losing the master key means re-entering the tokens.** This is documented, with advice to back
   up `.env` separately from the database.
8. **Outbound requests only go to the account's configured host.** Self-hosted URLs must be
   `https://`, except localhost for tests.

## 1. Database (migration `0002_accounts_repositories`)

**`credentials`:**

| Column                     | Notes                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| `id`                       | uuid PK                                                                          |
| `provider`                 |                                                                                  |
| `auth_type`                | `personal_access_token`, `project_access_token`, `group_access_token`, `api_key` |
| `ciphertext`               | `bytea`                                                                          |
| `key_version`              | which master key encrypted it                                                    |
| `fingerprint`              | display only                                                                     |
| `metadata`                 | jsonb, **non-secret**: token kind, scopes, expiry                                |
| `created_at`, `rotated_at` |                                                                                  |

**`connections`** (accounts):

| Column                          | Notes                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `id`                            | uuid PK                                                                      |
| `provider`                      | `github`, `gitlab`, `claude_code`                                            |
| `name`                          |                                                                              |
| `base_url`                      | API host, e.g. `https://gitlab.company.com`                                  |
| `account`                       | login/name found during verification                                         |
| `credential_id`                 | FK, nullable: a local Claude Code login has no stored credential             |
| `config`                        | jsonb, non-secret                                                            |
| `status`                        | `unconfigured`, `connected`, `degraded`, `expired`, `disconnected` (spec §5) |
| `last_checked_at`, `last_check` | last check time and result: ok, message, details                             |

**`project_repositories`:**

| Column                                                                        | Notes                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                                                                          | uuid PK                                                                 |
| `project_id`, `connection_id`                                                 | FKs (`RESTRICT`)                                                        |
| `purpose`                                                                     | `primary`; **unique (`project_id`, `purpose`)**                         |
| `provider`, `host`                                                            |                                                                         |
| `external_id`                                                                 | the provider's **stable repository id**; survives renames and transfers |
| `full_path`                                                                   | `owner/repo`, or GitLab's `group/subgroup/project`                      |
| `web_url`, `clone_url_https`, `clone_url_ssh`, `default_branch`, `visibility` | read from the provider                                                  |
| `access`                                                                      | jsonb: pull, push, reviewRequests (`unverified` until M5)               |
| `access_status`                                                               | `verified`, `denied`, `expired`, `unverified`                           |
| `verified_at`, `created_at`, `updated_at`                                     |                                                                         |

Also **unique (`provider`, `host`, `external_id`)**, which enforces D2.

**Projects created in M2 with a typed `repo_url`:** the URL is kept and shown as "not verified →
Connect". When you connect, the matching repo is suggested. After linking, `repo_url` and
`default_branch` come from the provider. `repoUrl` is removed from the project create/update API;
repositories are set only through the link endpoints.

## 2. Packages

```text
packages/vault/             #vault: AES-GCM, keyring, Secret type, key generation, rotation
packages/integrations/      #integrations: provider catalog and adapters
  code-host.ts              CodeHostAdapter interface (provider-agnostic)
  github/                   fetch-based GitHub adapter
  gitlab/                   fetch-based GitLab adapter
  claude-code/              local CLI probe
  testing/                  fake GitHub and GitLab HTTP servers for tests
packages/services/          + ConnectionService, RepositoryService
apps/worker/                + capability probe job (Claude Code check where agents run)
```

**`CodeHostAdapter`** is the contract every code host implements. Adding a provider means adding
one adapter:

```ts
verifyCredential(account, token) → { accountName, tokenKind, scopes, expiresAt, warnings }
listRepositories(account, token, { search, page }) → RepoSummary[]
getRepository(account, token, ref) → RepoDetails & { access: { pull, push } }
// M5 adds: createBranch, push via brokered credentials, openReviewRequest, getReviewStatus
```

**GitHub:**

| What     | How                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token    | fine-grained token, one resource owner. Permissions: **Contents R/W, Pull requests R/W, Metadata R**. Classic `ghp_` tokens work, with a warning that their scopes are broad |
| Verify   | `GET /user` (account) and the `github-authentication-token-expiration` header (expiry)                                                                                       |
| Repos    | `GET /user/repos` (paginated, searchable). Fine-grained tokens return only the repos you selected                                                                            |
| Access   | `GET /repos/{owner}/{repo}` → `permissions.pull` / `permissions.push`. Stable id = `id`                                                                                      |
| Base URL | `https://api.github.com`; GitHub Enterprise `https://<host>/api/v3`                                                                                                          |

**GitLab:**

| What     | How                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token    | **project access token recommended** (one project; role Developer+), or a group access token, or a personal access token. Scopes: `api` (needed to create merge requests in M5), `read_repository`, `write_repository` |
| Verify   | `GET /api/v4/personal_access_tokens/self` (scopes, expiry, active) and `GET /api/v4/user` (account)                                                                                                                    |
| Repos    | `GET /api/v4/projects?membership=true&min_access_level=20&search=` (paginated)                                                                                                                                         |
| Access   | `GET /api/v4/projects/:id` → access level: Reporter (20) = pull, Developer (30) = push. Protected branches are noted. Stable id = project `id`                                                                         |
| Base URL | `https://gitlab.com` or a self-hosted URL, set per account                                                                                                                                                             |

**Both:**

- Pull/merge-request permission can't be confirmed without creating one, so it shows as
  "confirmed on first PR/MR (M5)".
- 10 s timeouts. A 401 → `expired`; rate limits and timeouts → `degraded`.
- The UI says "pull request" for GitHub and "merge request" for GitLab; internally it's a generic
  **review request**.

**Claude Code probe:**

- The worker runs `claude --version`, plus a sign-in check, at startup and when you click Test. The
  exact non-interactive command will be checked against Claude Code's docs during implementation;
  any check that costs tokens runs only on explicit Test.
- No credential is stored. Your local login is a capability of this machine (spec §8).

## 3. API (`/api/v1`)

| Method | Path                                          | Purpose                                                                                                       |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/providers`                                  | catalog: providers, auth methods, field definitions, token help                                               |
| GET    | `/connections?provider=`                      | accounts with status and last check (never secrets)                                                           |
| POST   | `/connections`                                | `{ provider, name, baseUrl?, authType, secret }`; verified before saving, rejected with the reason if invalid |
| GET    | `/connections/:id`                            | detail, including the projects using this account                                                             |
| POST   | `/connections/:id/test`                       | re-run the check                                                                                              |
| POST   | `/connections/:id/rotate`                     | replace the token: `{ secret }`; re-verifies linked repos                                                     |
| POST   | `/connections/:id/disconnect`                 | wipe the encrypted token, status `disconnected`; linked repos become `unverified`                             |
| GET    | `/connections/:id/repositories?search=&page=` | repos this account can access                                                                                 |
| PUT    | `/projects/:project/repository`               | `{ connectionId, externalId }` → fetch details, verify access, link                                           |
| POST   | `/projects/:project/repository/verify`        | re-check access                                                                                               |
| DELETE | `/projects/:project/repository`               | unlink                                                                                                        |

## 4. Dashboard

1. **Project form → Repository step** (create and edit):

   ```text
   Repository
     ( ) No repository yet (planning only)
     (•) Connect a repository
           Account:    [ GitLab – company ▾ ]   [ + Add account ]
           Repository: [ search… team/app ▾ ]
                       ✅ pull  ✅ push  ⏳ merge requests (confirmed on first MR)
   ```

   **+ Add account** opens inline:
   - choose GitHub or GitLab
   - optionally enter a self-hosted URL
   - paste the token, with help listing the exact permissions and a link to the token page
   - the token is verified, and you return to the form with the new account selected

2. **Project page → Repository card:**
   - provider icon, path and link, default branch, access checklist, last verified time
   - **Verify again** button
   - clear states: "token expired → Replace token", "access denied", "not connected → Connect"
3. **Connections page:**
   - accounts grouped by provider, with status, account name, expiry ("expires in 12 days" warning)
     and the projects using each one
   - Test, Replace token and Disconnect actions
4. **Agent runtime card:** "Claude Code 2.x · signed in · checked 2 min ago", or setup steps if it
   isn't available.
5. Token fields are password inputs. There is no reveal option, before or after saving.

## 5. Tests

- **Vault (unit):**
  - round trip; tampered ciphertext, tag or associated data → rejected; wrong key → rejected
  - rotation; unknown key version → clear error
  - `Secret` never stringifies
- **Adapters** against **fake GitHub and GitLab servers**:
  - token verification; expiry and scopes; classic/broad-token warnings
  - 401, 403/429 rate limit, timeout
  - pagination and search
  - permission mapping (GitLab access levels → pull/push)
  - nested GitLab groups; self-hosted base URLs
- **Live tests (optional):** run against real GitHub/GitLab only when `GITHUB_TEST_TOKEN` /
  `GITLAB_TEST_TOKEN` (+ `GITLAB_TEST_URL`) are set; skipped otherwise. These are read-only.
- **Services (integration):**
  - raw DB rows contain no plaintext token
  - audit trail, including `credential.accessed`
  - a repo can't be linked to two projects (D2); a project has one primary repo (D1)
  - rotating a token re-verifies linked repos
  - disconnecting wipes the ciphertext and marks repos `unverified`
  - linking fails for repos the account can't see
- **API:** no response contains the secret; captured logs never contain it; error mapping.
- **Dashboard:**
  - repository step with inline add-account
  - repo search picker, access checklist
  - expired-token state
  - token field is a password input and never reappears
- **Worker:** the Claude Code probe parses version and sign-in status, and handles "not
  installed".

## 6. Acceptance criteria

1. Add, test, replace and disconnect **GitHub and GitLab** accounts (including a self-hosted
   GitLab URL) from the dashboard.
2. Several accounts per provider work side by side. Different projects can use different accounts
   and providers.
3. Tokens are stored encrypted, never returned by the API and never logged, verified by tests on
   the raw DB rows, responses and captured logs.
4. The master key lives outside the database. A missing or wrong key fails clearly. Rotation
   re-encrypts all secrets.
5. A project's repository is chosen in the project form from the account's repo list, stored by the
   provider's stable id, with pull and push access verified and shown.
6. One repository per project, and one project per repository, enforced by the database.
7. Claude Code availability (installed, version, signed in) is checked by the worker and shown.
8. Every token decryption and every account or repository change is audited.
9. lint, typecheck, unit, integration and dashboard tests and build all pass.

## 7. Order of work

1. ADR-003 and `#vault` (unit tests first)
2. Migration, `ConnectionService` and `RepositoryService` (integration tests)
3. `CodeHostAdapter` and the GitHub adapter, with its fake server
4. GitLab adapter, with its fake server
5. API routes (tests, including leak checks)
6. Worker Claude Code probe
7. Dashboard: repository step with inline add-account, repository card, Connections page, agent
   card
8. Docs, a manual check with your real GitHub and GitLab accounts, full verification

## What you'll need for the real check (at the end, not needed to build)

- **GitHub:** a fine-grained token per owner (your user and/or an org) for the repos you want,
  with **Contents R/W, Pull requests R/W, Metadata R**. Settings → Developer settings → Personal
  access tokens → Fine-grained tokens.
- **GitLab:** preferably a **project access token** per project (role Developer, scopes `api`,
  `read_repository`, `write_repository`), from Project → Settings → Access tokens. A personal
  access token with the same scopes works too, but covers everything you can access.
- You'll paste tokens into the dashboard yourself; I won't handle them. **M3 only reads**, so your
  existing repos are safe to connect. The first agent run that writes is M4/M5, and I'll suggest
  starting on a low-risk repo then.

## Looking ahead: M4 "Continue development"

The project page gets a **Continue development** button. It requires a verified repository. It
picks the next eligible task (in `backlog` or `changes_requested`, dependencies done, highest
priority first), runs Claude Code on it in an isolated worktree, and **stops at Ready for QA** for
your manual check. When work stops, the project shows the reason and the button resumes from there.
