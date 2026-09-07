export class SyncError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false,
    readonly retryAfterMs = 0, readonly details?: unknown, readonly status?: number) {
    super(message);
    this.name = 'SyncError';
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export function retryDelay(attempt: number, random = Math.random()): number {
  return Math.round(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)) * (0.5 + random * 0.5));
}

export async function syncResponseError(response: Response): Promise<SyncError> {
  const payload: unknown = await response.json().catch(() => ({}));
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const retryable = response.status === 429 || response.status >= 500;
  const reason = response.status === 413
    ? 'Пачка превышает лимит сервера. Сократите запись или проверьте лимит прокси.'
    : retryable ? 'Сервер временно недоступен. Повторим автоматически.'
      : 'Сервер отклонил изменения. Исправьте данные и повторите синхронизацию.';
  const details = body.details;
  const recordId = details && typeof details === 'object' && 'recordId' in details && typeof details.recordId === 'string' ? details.recordId.slice(0, 160) : undefined;
  const suffix = recordId ? ` Запись: ${recordId}.` : '';
  return new SyncError(reason + suffix, typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
    retryable, retryAfterMs(response.headers.get('Retry-After')), details, response.status);
}
