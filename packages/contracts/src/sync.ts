import { z } from 'zod';
import { id, number, workoutType, log, workout, profile, identityProfile, backupDataSchema } from './entities.js';

export const syncRequestSchema = z.object({
  cursor: number.int(),
  // Missing version remains supported for legacy clients until S09.
  protocolVersion: z.literal(1).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  batchId: id.refine((value) => value.length <= 100).optional(),
  changes: z.object({
    workoutTypes: z.array(workoutType.strict()).optional(),
    logs: z.array(log.strict()).optional(),
    workouts: z.array(workout.strict()).optional(),
    // Strip legacy identity fields rather than accepting them as authoritative.
    profile: profile.extend({ id: z.literal('me') }).nullish(),
  }).strict().superRefine((data, ctx) => {
    for (const key of ['workoutTypes', 'logs', 'workouts'] as const) {
      const seen = new Set<string>();
      data[key]?.forEach((item, index) => {
        if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'Duplicate ID' });
        seen.add(item.id);
      });
    }
  }),
}).strict();

export const syncEntitySchemas = { workoutTypes: workoutType, logs: log, workouts: workout, profile: profile.extend({ id: z.literal('me') }) };
const reference = z.object({
  entityType: z.enum(['workoutTypes', 'logs', 'workouts', 'profile']), entityId: id,
}).refine((value) => value.entityType !== 'profile' || value.entityId === 'me', 'Invalid profile ID');
export const syncResponseSchema = z.object({
  // Explicit legacy compatibility until S09 removes optional protocol/ack fields.
  protocolVersion: z.literal(1).optional(),
  cursor: number.int(), hasMore: z.boolean().optional(),
  acknowledged: z.array(reference).optional(),
  conflicts: z.array(z.object({
    entityType: reference.shape.entityType, entityId: id,
    reason: z.literal('stale-version'), serverVersion: number.int(),
  }).refine((value) => value.entityType !== 'profile' || value.entityId === 'me', 'Invalid profile ID')),
  changes: z.object({
    workoutTypes: z.array(workoutType).optional(), logs: z.array(log).optional(), workouts: z.array(workout).optional(),
    profile: identityProfile.extend({ id: z.literal('me') }).nullish(),
  }).superRefine((data, ctx) => {
    for (const key of ['workoutTypes', 'logs', 'workouts'] as const) {
      const seen = new Set<string>();
      data[key]?.forEach((item, index) => {
        if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'Duplicate ID' });
        seen.add(item.id);
      });
    }
  }),
});

export const backupImportSchema = z.object({
  mode: z.enum(['merge', 'replace']), expectedRevision: number.int(), data: backupDataSchema,
}).strict();
