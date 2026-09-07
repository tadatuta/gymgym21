import { HttpError } from '../http/errors.js';

export const STORAGE_PROFILE_ID = 'me';
export const MAX_NAME_LENGTH = 100;
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_LOG_COUNT = 10000;
export function sanitizeStorageKey(storageKey: string | number): string {
  const sanitized = String(storageKey).trim();
  if (!sanitized || !/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
    throw new HttpError(400, 'Invalid storage key');
  }
  return sanitized;
}

export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAlias(alias: string): string {
  return alias.trim().replace(/^@/, '').toLowerCase();
}

export function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string' && value.length > 0) {
    return Number(value);
  }

  return 0;
}

export function toIsoString(value: string | Date | null | undefined, fallback?: string): string {
  if (!value) {
    if (!fallback) {
      return new Date().toISOString();
    }
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    if (fallback) {
      return fallback;
    }
    throw new HttpError(400, 'Invalid timestamp');
  }

  return date.toISOString();
}

export function normalizeTimestamp(candidate: string | undefined, fallback: string): string {
  return candidate ? toIsoString(candidate, fallback) : fallback;
}
