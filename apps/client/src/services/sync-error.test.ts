import { expect, it } from 'vitest';
import { retryAfterMs, retryDelay, syncResponseError } from './sync-error';

it('parses Retry-After seconds and dates and bounds exponential jitter', () => {
  expect(retryAfterMs('12')).toBe(12000);
  expect(retryAfterMs('Tue, 01 Sep 2026 00:01:00 GMT', Date.parse('2026-09-01T00:00:00Z'))).toBe(60000);
  expect(retryAfterMs('invalid')).toBe(0);
  expect(retryDelay(0, 0)).toBe(500);
  expect(retryDelay(0, 1)).toBe(1000);
  expect(retryDelay(100, 1)).toBe(60000);
});
it('classifies busy/rate limits and permanent rejection with record details', async () => {
  for (const status of [429, 503]) {
    expect(await syncResponseError(new Response(JSON.stringify({ code: 'ROUTE_BUSY' }), { status, headers: { 'Retry-After': '60' } })))
      .toMatchObject({ retryable: true, retryAfterMs: 60000, code: 'ROUTE_BUSY' });
  }
  for (const status of [400, 409, 413]) {
    expect(await syncResponseError(new Response(JSON.stringify({ details: { recordId: 'bad' } }), { status })))
      .toMatchObject({ retryable: false, details: { recordId: 'bad' } });
  }
});
