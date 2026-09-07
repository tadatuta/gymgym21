import { syncResponseSchema } from '@gym21/contracts';
export { syncEntitySchemas } from '@gym21/contracts';
import type { SyncResponse } from '../types';
import { SyncError } from './sync-error';

export function parseSyncResponse(value: unknown): SyncResponse {
  const parsed = syncResponseSchema.safeParse(value);
  if (!parsed.success) throw new SyncError('Некорректный ответ сервера. Данные сохранены локально; повторите позже или обратитесь в поддержку.', 'INVALID_RESPONSE');
  // Older records may omit metadata; existing apply logic supports that compatibility.
  return { ...parsed.data, changes: { ...parsed.data.changes, profile: parsed.data.changes.profile ?? undefined } } as SyncResponse;
}
