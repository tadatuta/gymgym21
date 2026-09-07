import { z } from 'zod';
import { id, number, workoutType, log, workout, profile } from '../storage/backup-validation';
import type { SyncResponse } from '../types';
import { SyncError } from './sync-error';

export const syncEntitySchemas = { workoutTypes: workoutType, logs: log, workouts: workout, profile: profile.extend({ id: z.literal('me') }) };
const reference = z.object({
  entityType: z.enum(['workoutTypes', 'logs', 'workouts', 'profile']), entityId: id,
}).refine((value) => value.entityType !== 'profile' || value.entityId === 'me', 'Invalid profile ID');
const responseSchema = z.object({
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
    profile: profile.extend({ id: z.literal('me'), username: id.optional(), telegramUsername: id.optional(), telegramUserId: number.int().optional() }).nullish(),
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

export function parseSyncResponse(value: unknown): SyncResponse {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new SyncError('Некорректный ответ сервера. Данные сохранены локально; повторите позже или обратитесь в поддержку.', 'INVALID_RESPONSE');
  // Older records may omit metadata; existing apply logic supports that compatibility.
  return { ...parsed.data, changes: { ...parsed.data.changes, profile: parsed.data.changes.profile ?? undefined } } as SyncResponse;
}
