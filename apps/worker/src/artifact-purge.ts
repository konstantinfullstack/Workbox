import type { Logger } from '#core';
import type { ArtifactStore } from '#services';

export const ARTIFACT_PURGE_INTERVAL_MS = 60 * 60_000;

/** Deletes expired run files once right away, then every hour. Returns a stop function. */
export function startArtifactPurge(options: {
  store: ArtifactStore;
  logger: Logger;
  intervalMs?: number;
}): () => Promise<void> {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = options.store
      .purgeExpired()
      .then(
        (deleted) => {
          if (deleted > 0) options.logger.info({ deleted }, 'expired run files deleted');
        },
        (error: unknown) => options.logger.warn({ err: error }, 'run file cleanup failed'),
      )
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? ARTIFACT_PURGE_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
