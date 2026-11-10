import { z } from 'zod';
import {
  CODE_HOST_PROVIDERS,
  PROJECT_STATUSES,
  REPOSITORY_ACCESS_STATUSES,
  TASK_STATES,
} from './domain.js';
import { isValidBranchName, SLUG_MAX_LENGTH, SLUG_PATTERN } from './validation.js';

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

const nameSchema = z.string().trim().min(1, 'is required').max(100);
const slugSchema = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, 'must be lowercase letters, digits and single hyphens');
const descriptionSchema = z.string().max(10_000);
const branchSchema = z
  .string()
  .refine(isValidBranchName, { message: 'is not a valid Git branch name' });

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  /** Clone URL of the linked repository, or a legacy (unverified) URL typed in before M3. */
  repoUrl: z.string().nullable(),
  defaultBranch: z.string(),
  status: projectStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

export const taskCountsSchema = z.record(z.enum(TASK_STATES), z.number().int().nonnegative());
export type TaskCounts = z.infer<typeof taskCountsSchema>;

export const projectSummarySchema = projectSchema.extend({
  taskCounts: taskCountsSchema,
  totalTasks: z.number().int().nonnegative(),
  /** Linked primary repository (null when none is linked yet). */
  repository: z
    .object({
      provider: z.enum(CODE_HOST_PROVIDERS),
      fullPath: z.string(),
      webUrl: z.string(),
      accessStatus: z.enum(REPOSITORY_ACCESS_STATUSES),
    })
    .nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

// Strict: unknown fields (e.g. the pre-M3 `repoUrl`) are rejected rather than silently ignored.
export const createProjectInputSchema = z.strictObject({
  name: nameSchema,
  /** Generated from the name when omitted. Immutable after creation (used in URLs and CLI). */
  slug: slugSchema.optional(),
  description: descriptionSchema.optional(),
  defaultBranch: branchSchema.optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z
  .strictObject({
    name: nameSchema,
    description: descriptionSchema,
    defaultBranch: branchSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const listProjectsQuerySchema = z.object({
  status: projectStatusSchema.optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
