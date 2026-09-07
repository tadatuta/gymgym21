import type { AppData, SyncItem, UserProfile, WorkoutSession, WorkoutSet, WorkoutType } from '../types';

export type BackupMode = 'merge' | 'replace';
type BackupEntity<T> = Omit<T, keyof SyncItem>;
export interface BackupEnvelope {
    format: 'gym21-backup';
    version: 1;
    exportedAt: string;
    data: {
        workoutTypes: BackupEntity<WorkoutType>[];
        workouts: BackupEntity<WorkoutSession>[];
        logs: BackupEntity<WorkoutSet>[];
        profile?: Omit<BackupEntity<UserProfile>, 'username' | 'telegramUsername' | 'telegramUserId'>;
    };
}

function stripMetadata<T extends object>(item: T): T {
    const result = { ...item } as T & Record<string, unknown>;
    for (const key of ['version', 'serverUpdatedAt', 'updatedAt', 'isDeleted', 'username', 'telegramUsername', 'telegramUserId']) delete result[key];
    return result;
}

export function createBackup(data: AppData): BackupEnvelope {
    return {
        format: 'gym21-backup', version: 1, exportedAt: new Date().toISOString(),
        data: {
            workoutTypes: data.workoutTypes.filter((item) => !item.isDeleted).map(stripMetadata),
            workouts: data.workouts.filter((item) => !item.isDeleted).map(stripMetadata),
            logs: data.logs.filter((item) => !item.isDeleted).map(stripMetadata),
            ...(data.profile && !data.profile.isDeleted ? { profile: stripMetadata(data.profile) } : {}),
        },
    };
}

// Legacy AppData exports remain readable, but their sync versions and identity are never trusted.
export function readBackup(input: unknown): AppData {
    if (!input || typeof input !== 'object') throw new Error('Неверный формат файла');
    const envelope = input as Record<string, unknown>;
    if ('format' in envelope && (envelope.format !== 'gym21-backup' || envelope.version !== 1)) throw new Error('Неподдерживаемая версия резервной копии');
    const data = ('format' in envelope ? envelope.data : input) as AppData;
    if (!data || !Array.isArray(data.workoutTypes) || !Array.isArray(data.logs) || (data.workouts !== undefined && !Array.isArray(data.workouts))) throw new Error('Неверный формат файла');
    const now = new Date().toISOString();
    const normalize = <T extends SyncItem & { id: string }>(items: T[]): T[] => {
        const ids = new Set<string>();
        return items.filter((item) => {
            if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('Неверный или повторяющийся ID в файле');
            ids.add(item.id);
            return !item.isDeleted;
        }).map((item) => ({ ...stripMetadata(item), updatedAt: now }));
    };
    return {
        workoutTypes: normalize(data.workoutTypes), logs: normalize(data.logs), workouts: normalize(data.workouts ?? []),
        ...(data.profile ? { profile: normalize([{ ...data.profile, id: 'me' }])[0] } : {}),
    };
}
