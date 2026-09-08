import { describe, expect, it } from 'vitest';
import { syncRequestSchema, publicProfileSchema } from '@gym21/contracts';
import fixtures from '../../../../test/fixtures/contracts.json';
import { parseSyncResponse } from './sync-validation';

describe('shared wire examples through client contracts', () => {
  for (const fixture of fixtures.validRequests) {
    it(`accepts request: ${fixture.name}`, () => {
      expect(syncRequestSchema.parse(fixture.value)).toEqual(fixture.value);
    });
  }
  for (const fixture of fixtures.invalidRequests) {
    it(`rejects request: ${fixture.name}`, () => {
      expect(syncRequestSchema.safeParse(fixture.value).success).toBe(false);
    });
  }
  for (const fixture of fixtures.validResponses) {
    it(`parses response: ${fixture.name}`, () => {
      expect(parseSyncResponse(fixture.value)).toEqual({
        ...fixture.value, changes: { ...fixture.value.changes, profile: undefined },
      });
    });
  }
  for (const fixture of fixtures.invalidResponses) {
    it(`rejects response: ${fixture.name}`, () => {
      expect(() => parseSyncResponse(fixture.value)).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    });
  }
  it('rejects non-JSON NaN locally', () => {
    expect(() => parseSyncResponse({ ...fixtures.validResponses[0].value, cursor: NaN })).toThrow();
  });
  it('accepts the public HTTP DTO', () => {
    expect(publicProfileSchema.parse(fixtures.publicProfile)).toEqual(fixtures.publicProfile);
  });
});
