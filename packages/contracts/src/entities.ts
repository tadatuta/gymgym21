import { validTimeZone } from './training-time.js';
import { z } from 'zod';

// Entity rules are reused by backup and incremental sync contracts.
export const id = z.string().min(1).max(200).refine((value) => !value.includes('\0'), 'Invalid NUL character').refine((value) => value.trim().length > 0, 'Empty ID');
const text = z.string().max(10000).refine((value) => !value.includes('\0'), 'Invalid NUL character');
export const timestamp = z.iso.datetime({ offset: true }).refine((value) => !value.startsWith('0000') && Number.isFinite(Date.parse(value)), 'Invalid timestamp');
export const number = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
export const metadata = {
    id,
    updatedAt: timestamp.optional(),
    serverUpdatedAt: timestamp.optional(),
    version: number.int().optional(),
    isDeleted: z.boolean().optional(),
};
export const workoutType = z.object({
    ...metadata, name: text.min(1), category: z.enum(['strength', 'time']).optional(),
    order: z.number().int().min(0).max(2147483647).optional(),
});
export const log = z.object({
    ...metadata, workoutTypeId: id, workoutId: z.union([id, z.literal('')]).optional(),
    date: timestamp, reps: number.int().optional(), weight: number.optional(),
    duration: number.optional(), durationSeconds: z.number().int().min(0).max(59).optional(),
});
export const interval = z.object({ start: timestamp, end: timestamp.optional() }).refine(
    (value) => !value.end || Date.parse(value.end) >= Date.parse(value.start),
    { message: 'End precedes start', path: ['end'] },
);
export const workout = z.object({
    ...metadata, startTime: timestamp, endTime: timestamp.optional(), name: text.optional(),
    status: z.enum(['active', 'paused', 'finished']), isManual: z.boolean(), pauseIntervals: z.array(interval),
}).refine((value) => !value.endTime || Date.parse(value.endTime) >= Date.parse(value.startTime),
    { message: 'End precedes start', path: ['endTime'] });
export const profile = z.object({
    ...metadata, isPublic: z.boolean(), showFullHistory: z.boolean().optional(),
    timeZone: z.string().max(100).refine(validTimeZone, { message: 'Invalid IANA time zone' }).optional(),
    displayName: text.optional(), photoUrl: text.optional(), createdAt: timestamp,
    gender: z.enum(['male', 'female', 'other']).optional(),
    birthDate: z.union([z.iso.date().refine((value) => !value.startsWith('0000'), 'Invalid year'), z.literal('')]).optional().transform((value) => value || undefined),
    height: z.number().positive().max(300).optional(), weight: z.number().positive().max(1000).optional(),
    additionalInfo: text.optional(),
    friends: z.array(z.object({ identifier: id, displayName: text, photoUrl: text.optional(), addedAt: timestamp })).optional(),
});

export const backupDataSchema = z.object({
    workoutTypes: z.array(workoutType), logs: z.array(log), workouts: z.array(workout), profile: profile.optional(),
}).superRefine((data, ctx) => {
    for (const key of ['workoutTypes', 'logs', 'workouts'] as const) {
        const seen = new Set<string>();
        data[key].forEach((item, index) => {
            if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'Duplicate ID' });
            seen.add(item.id);
        });
    }
    // Orphan references are valid domain data: deleting a type retains its logs, and
    // pre-session backups have no workouts. IDs are checked above, targets are unique,
    // but absence of a target must not discard a historical log or resurrect a deletion.
});
export const backupEnvelopeSchema = z.object({
    format: z.literal('gym21-backup'), version: z.literal(1), exportedAt: timestamp, data: backupDataSchema,
});

export const identityProfile = profile.extend({
    username: id.optional(), telegramUsername: id.optional(), telegramUserId: number.int().optional(),
});
