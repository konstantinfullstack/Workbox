import { DomainError } from '#core';
import { isCodeHostError, type CodeHostError } from '#integrations';
import { ERROR_CODES, type ConnectionStatus } from '#shared';
import { VaultDecryptError, VaultKeyError } from '#vault';

/** Connection status implied by a failed call to its provider. */
export function statusForFailure(error: CodeHostError): ConnectionStatus {
  return error.kind === 'unauthorized' ? 'expired' : 'degraded';
}

/** Converts provider/vault failures into DomainErrors the API maps to HTTP statuses. */
export function toDomainError(error: unknown): unknown {
  if (isCodeHostError(error)) {
    switch (error.kind) {
      case 'unauthorized':
      case 'forbidden':
        return new DomainError(ERROR_CODES.credentialRejected, error.message, { kind: error.kind });
      case 'not_found':
        return new DomainError(ERROR_CODES.notFound, error.message, { kind: error.kind });
      case 'invalid_url':
        return new DomainError(ERROR_CODES.validation, error.message, { kind: error.kind });
      default:
        return new DomainError(ERROR_CODES.codeHostUnavailable, error.message, {
          kind: error.kind,
        });
    }
  }
  if (error instanceof VaultDecryptError || error instanceof VaultKeyError) {
    return new DomainError(
      ERROR_CODES.credentialUnreadable,
      'the stored token cannot be decrypted with the current master key; replace the token',
    );
  }
  return error;
}
