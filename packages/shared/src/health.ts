import { z } from 'zod';

/** Liveness: the process is up and able to serve requests. Never checks dependencies. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const dependencyStatusSchema = z.enum(['up', 'down']);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const dependencyCheckSchema = z.object({
  status: dependencyStatusSchema,
  latencyMs: z.number().nonnegative(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/** Readiness: the process can do useful work because its dependencies are reachable. */
export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), dependencyCheckSchema),
  timestamp: z.iso.datetime(),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
