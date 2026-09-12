import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncEntityContentEqual as equal } from '@gym21/contracts';

const date = '2026-09-01T12:00:00Z';
const log = { id: 'L', workoutTypeId: 'T', date, reps: 5, weight: 20 };
test('sync content ignores transport metadata, property order and explicit legacy defaults', () => {
    assert(equal('logs', log, { ...log, date: '2026-09-01T15:00:00+03:00', version: 42,
        updatedAt: date, serverUpdatedAt: date, isDeleted: false, duration: 0, durationSeconds: 0 }));
    assert(equal('workouts', { id: 'W', startTime: date }, { id: 'W', startTime: date, isManual: false, pauseIntervals: [], isDeleted: false }));
    assert(equal('profile', { id: 'me', createdAt: date }, { id: 'me', createdAt: date, isPublic: false, showFullHistory: false, friends: [] }));
});
test('sync content retains measurements, identity, deletion, domain dates, privacy and unknown fields', () => {
    for (const delta of [{ id: 'other' }, { reps: 6 }, { reps: undefined }, { weight: 0 }, { durationSeconds: 1 },
        { workoutTypeId: 'other' }, { workoutId: 'W' }, { isDeleted: true }, { date: '2026-09-02T12:00:00Z' }, { futureField: 'keep' }]) {
        assert(!equal('logs', log, { ...log, ...delta }), JSON.stringify(delta));
    }
    const profile = { id: 'me', createdAt: date, username: 'owner', isPublic: false };
    for (const delta of [{ username: 'other' }, { isPublic: true }, { timeZone: 'Europe/Moscow' }, { createdAt: '2026-09-02T12:00:00Z' }]) {
        assert(!equal('profile', profile, { ...profile, ...delta }));
    }
    assert(!equal('workouts', { id: 'W', pauseIntervals: [{ start: date }] }, { id: 'W', pauseIntervals: [] }));
    assert(!equal('logs', { ...log, custom: { updatedAt: 'a' } }, { ...log, custom: { updatedAt: 'b' } }));
    assert(!equal('logs', undefined, undefined));
    assert(!equal('logs', {}, {}));
});
