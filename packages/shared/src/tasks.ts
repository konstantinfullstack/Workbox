import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATES } from './domain.js';

export const taskStateSchema = z.enum(TASK_STATES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);

const titleSchema = z.string().trim().min(1, 'is required').max(200);
const descriptionSchema = z.string().max(50_000);
const acceptanceCriteriaSchema = z.array(z.string().trim().min(1).max(1_000)).max(50);
const dependsOnSchema = z.array(z.uuid()).max(50);
const versionSchema = z.number().int().positive();
const reasonSchema = z.string().trim().min(1).max(2_000);

export const taskSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: taskPrioritySchema,
  state: taskStateSchema,
  version: z.number().int().positive(),
  dependsOn: z.array(z.uuid()),
  /** States this task may move to next. Computed by the backend; clients must not re-derive it. */
  allowedTransitions: z.array(taskStateSchema),
  stateChangedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskListSchema = z.object({
  items: z.array(taskSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type TaskList = z.infer<typeof taskListSchema>;

export const createTaskInputSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.optional(),
  acceptanceCriteria: acceptanceCriteriaSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dependsOn: dependsOnSchema.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    acceptanceCriteria: acceptanceCriteriaSchema,
    priority: taskPrioritySchema,
    dependsOn: dependsOnSchema,
    /** Optimistic concurrency guard: rejected with 409 if the task changed since it was read. */
    expectedVersion: versionSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), {
    message: 'at least one field is required',
  });
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const transitionTaskInputSchema = z.object({
  to: taskStateSchema,
  reason: reasonSchema.optional(),
  expectedVersion: versionSchema.optional(),
});
export type TransitionTaskInput = z.infer<typeof transitionTaskInputSchema>;

export const taskTransitionSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  fromState: taskStateSchema.nullable(),
  toState: taskStateSchema,
  actor: z.string(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TaskTransition = z.infer<typeof taskTransitionSchema>;

export const listTasksQuerySchema = z.object({
  state: taskStateSchema.optional(),
  priority: taskPrioritySchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
