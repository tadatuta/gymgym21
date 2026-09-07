import { describe, expect, it } from 'vitest';
import { createBackup, readBackup } from './backup';

describe('portable backups', () => {
    it('exports live data in a versioned envelope without sync metadata or trusted identity', () => {
        const envelope = createBackup({ workoutTypes: [
            { id: 'A', name: 'A', version: 999, serverUpdatedAt: 'old', updatedAt: 'old' },
            { id: 'B', name: 'B', isDeleted: true, updatedAt: 'old' },
        ], logs: [], workouts: [], profile: { id: 'me', isPublic: true, username: 'foreign', telegramUserId: 999, updatedAt: 'old', createdAt: 'old' } });
        expect(envelope).toMatchObject({ format: 'gym21-backup', version: 1, data: { workoutTypes: [{ id: 'A', name: 'A' }] } });
        expect(envelope.data.workoutTypes[0]).not.toHaveProperty('version');
        expect(envelope.data.profile).not.toHaveProperty('telegramUserId');
        expect(readBackup(envelope).workoutTypes[0]).toMatchObject({ id: 'A', name: 'A' });
    });
    it('accepts legacy backups without workouts and discards old versions', () => {
        const data = readBackup({ workoutTypes: [{ id: 'A', name: 'modified A', version: 999, serverUpdatedAt: 'future' }], logs: [] });
        expect(data.workouts).toEqual([]);
        expect(data.workoutTypes[0]).not.toHaveProperty('version');
        expect(data.workoutTypes[0]).not.toHaveProperty('serverUpdatedAt');
        expect(() => readBackup({ format: 'gym21-backup', version: 2 })).toThrow('версия');
    });
});
