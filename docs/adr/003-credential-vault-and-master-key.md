# ADR-003: Credential vault and master key lifecycle

- **Status:** Accepted
- **Date:** 2026-11-04
- **Milestone:** M3

## Context

Workbox stores tokens for code hosts (GitHub, GitLab) and later for model providers and Telegram.
The spec (§8, §11) requires:

- encryption at rest with authenticated encryption
- a master key kept **outside the database**
- key versioning for rotation
- secrets never returned to clients after submission
- redaction in logs
- every credential access audited

Workbox is a personal, self-hosted tool for now.

## Decision

1. **Algorithm:** AES-256-GCM via `node:crypto`. Each secret gets a random 96-bit IV and a
   128-bit authentication tag.
   - Stored format: `[0x01 format][IV][tag][ciphertext]`. The format byte allows a future
     algorithm change.
   - The credential id and provider (`<credentialId>:<provider>`) are bound as **associated
     data**, so an encrypted blob copied onto another row fails to decrypt.
2. **Master key:** 32 random bytes, base64, in `WORKBOX_MASTER_KEY` in the git-ignored `.env`.
   - `pnpm vault:generate-key` writes it into `.env` without printing it, and refuses to overwrite
     an existing key.
   - The API refuses to start without a valid key. `.env.example` leaves the value empty, because
     a committed example key would effectively be a real key.
   - Hosted deployments will replace this with a KMS or secret manager behind the same `Keyring`
     interface.
3. **Versioning and rotation:** every ciphertext stores its `key_version`
   (`WORKBOX_MASTER_KEY_VERSION`, default 1). To rotate:
   1. Move the old key to `WORKBOX_PREVIOUS_MASTER_KEYS` as `<version>:<base64>`.
   2. Generate a new key and bump the version.
   3. Run `pnpm vault:rotate`, which re-encrypts every credential under the current key in one
      transaction.
   4. Remove the old key afterwards.
4. **Plaintext handling:** decrypted values are `Secret` objects. Their string, JSON,
   template-literal and `util.inspect` forms all print `[REDACTED]`; only `.reveal()` returns the
   value, called right where a request is sent to the provider.
   - The API returns only a fingerprint (known prefix + last 4 characters).
   - Pino redaction covers token-like fields.
5. **Audit:** every decryption writes `credential.accessed` (purpose, trace id) to `audit_logs`.
   Account create, test, rotate and disconnect are also audited. Metadata never contains secret
   material.
6. **Disconnect** deletes the ciphertext (the row stays for history). There is no "reveal secret"
   endpoint.
7. **Agents never receive tokens.** Workbox performs code-host operations itself (M5). Agent
   sandboxes get a working copy, not credentials (spec §11).

## Consequences

- **Losing the master key loses the stored credentials.** Tokens must then be re-entered; nothing
  else is affected. Back up `.env` separately from database backups. Having both in one place
  defeats the encryption.
- **The vault is only as strong as the host.** Anyone who can read `.env` on the host can decrypt.
  That's acceptable for a single-user local tool and documented; hosted deployments need a KMS.
- **Key rotation needs a brief restart** with both keys configured.
