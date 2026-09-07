import type { z } from 'zod';
import type { metadata, interval, workoutType, log, workout, profile, identityProfile, backupDataSchema, backupEnvelopeSchema } from './entities.js';
import type { syncRequestSchema, syncResponseSchema, backupImportSchema } from './sync.js';

export type SyncMetadata = z.infer<z.ZodObject<typeof metadata>>;
export type WorkoutType = z.infer<typeof workoutType>;
export type WorkoutSet = z.infer<typeof log>;
export type WorkoutSession = z.infer<typeof workout>;
export type WorkoutStatus = WorkoutSession['status'];
export type PauseInterval = z.infer<typeof interval>;
// Serializable records can omit birthDate; parsing normalizes blank dates to undefined.
export type UserProfile = z.input<typeof identityProfile>;
export type WritableProfile = z.input<typeof profile>;
export type Friend = NonNullable<UserProfile['friends']>[number];
export type BackupData = z.input<typeof backupDataSchema>;
export type BackupEnvelope = z.input<typeof backupEnvelopeSchema>;
export type BackupImport = z.infer<typeof backupImportSchema>;
export type BackupMode = BackupImport['mode'];
export type SyncRequest = z.infer<typeof syncRequestSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
export type SyncChanges = SyncResponse['changes'];
export type SyncConflict = SyncResponse['conflicts'][number];
export type SyncAcknowledgement = NonNullable<SyncResponse['acknowledged']>[number];
export type SyncEntityType = SyncAcknowledgement['entityType'];

// Current servers always emit every collection and protocol field. The wire
// reader above still accepts legacy omissions until compatibility removal (S09).
export type CompleteSyncResponse = Required<Omit<SyncResponse, 'changes'>> & {
    changes: { workoutTypes: WorkoutType[]; logs: WorkoutSet[]; workouts: WorkoutSession[]; profile: UserProfile | null };
};
