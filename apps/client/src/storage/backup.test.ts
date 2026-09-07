import { describe, expect, it } from 'vitest';
import { createBackup, readBackup } from './backup';

describe('portable backups', () => {
    it('exports live data in a versioned envelope without sync metadata or trusted identity', () => {
        const envelope = createBackup({ workoutTypes: [
            { id: 'A', name: 'A', version: 999, serverUpdatedAt: 'old', updatedAt: 'old' },
            { id: 'B', name: 'B', isDeleted: true, updatedAt: 'old' },
        ], logs: [], workouts: [], profile: { id: 'me', isPublic: true, username: 'foreign', telegramUserId: 999, updatedAt: 'old', createdAt: '2026-09-01T00:00:00Z' } });
        expect(envelope).toMatchObject({ format: 'gym21-backup', version: 1, data: { workoutTypes: [{ id: 'A', name: 'A' }] } });
        expect(envelope.data.workoutTypes[0]).not.toHaveProperty('version');
        expect(envelope.data.profile).not.toHaveProperty('telegramUserId');
        expect(readBackup(envelope).workoutTypes[0]).toMatchObject({ id: 'A', name: 'A' });
    });
    it('accepts legacy backups without workouts and discards old versions', () => {
        const data = readBackup({ workoutTypes: [{ id: 'A', name: 'modified A', version: 999, serverUpdatedAt: '2026-09-01T00:00:00Z' }], logs: [] });
        expect(data.workouts).toEqual([]);
        expect(data.workoutTypes[0]).not.toHaveProperty('version');
        expect(data.workoutTypes[0]).not.toHaveProperty('serverUpdatedAt');
        expect(() => readBackup({ format: 'gym21-backup', version: 2 })).toThrow('версия');
    });
});

import { invalidBackupCases, validBackupData } from './backup-fixtures.test-helper';

it.each(invalidBackupCases)('rejects malformed field %s with its location', (path, input) => {
    expect(() => readBackup(input)).toThrow(path);
});
it('validates the envelope and exported timestamp, including nested data', () => {
    const envelope = { format: 'gym21-backup', version: 1, exportedAt: '2026-09-01T00:00:00Z', data: validBackupData() };
    expect(readBackup(envelope).profile?.birthDate).toBeUndefined();
    expect(() => readBackup({ ...envelope, exportedAt: 'tomorrow' })).toThrow('exportedAt');
    expect(() => readBackup({ ...envelope, data: null })).toThrow('data');
    expect(() => readBackup({ ...envelope, data: { ...envelope.data, workouts: undefined } })).toThrow('workouts');
});
it('roundtrips orphan IDs and legacy missing workouts without synthesizing deleted targets', () => {
    const input = validBackupData();
    const data = readBackup({ ...input, workouts: undefined, workoutTypes: [] });
    expect(data.logs[0]).toMatchObject({ workoutTypeId: 'type', workoutId: 'workout' });
    const restored = readBackup(createBackup(data));
    // Import creates fresh sync timestamps; compare the portable domain payload.
    expect(createBackup(restored).data.logs).toEqual(createBackup(data).data.logs);
    expect(restored.workoutTypes).toEqual([]);
    expect(restored.workouts).toEqual([]);
});

it('roundtrips the owner time zone in portable backups', () => {
    const data = readBackup({ ...validBackupData(), profile: { ...validBackupData().profile, timeZone: 'Europe/Berlin' } });
    expect(readBackup(createBackup(data)).profile?.timeZone).toBe('Europe/Berlin');
});

it('normalizes a valid legacy profile ID after validation', () => {
    const input = validBackupData();
    expect(readBackup({ ...input, profile: { ...input.profile, id: '12345' } }).profile?.id).toBe('me');
});
