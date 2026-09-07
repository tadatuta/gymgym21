import { expect, it } from 'vitest';
import { getTrainingActivity } from './training-activity';
import { renderProfileStats } from '../components/profile/ProfileStats';
it('normalizes UTC days identically to server and labels days explicitly', () => {
  const fixtures = [
    { date: '2026-01-01T23:30:00-03:00' },
    { date: '2026-01-02T02:30:00Z' },
    { date: '2026-01-03T00:00:00Z', isDeleted: true },
    { date: 'invalid' },
  ];
  expect([...getTrainingActivity(fixtures)]).toEqual([['2026-01-02', 2]]);
  expect(renderProfileStats({ totalWorkouts: getTrainingActivity(fixtures).size, totalVolume: 0 })).toContain('Тренировочных дней');
});
