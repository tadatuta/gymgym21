import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';

const AUTH_TOKEN_KEY = 'gym_auth_token';
const DEFAULT_AUTH_BASE_URL = '/api/auth';

function normalizeBaseUrl(value: string): string {
  if (value === '/') {
    return '';
  }

  return value.replace(/\/+$/, '');
}

function ensureAbsoluteUrl(value: string): string {
  const normalized = normalizeBaseUrl(value);

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost';

  return new URL(normalized.startsWith('/') ? normalized : `/${normalized}`, origin).toString().replace(/\/+$/, '');
}

function deriveApiBaseUrl(authBaseUrl: string): string {
  return authBaseUrl.replace(/\/api\/auth$/, '/api');
}

function resolveUrl(baseUrl: string, path = ''): string {
  if (!path) {
    return baseUrl;
  }

  if (/^https?:\/\//.test(path)) {
    return path;
  }

  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

const AUTH_BASE_URL = ensureAbsoluteUrl(import.meta.env.VITE_AUTH_BASE_URL || DEFAULT_AUTH_BASE_URL);
const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL || deriveApiBaseUrl(AUTH_BASE_URL));
export const TELEGRAM_BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME || 'gymgym21bot';



export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  username?: string | null;
  displayUsername?: string | null;
  migrationCompleted?: boolean;
}

export interface AuthSession {
  session: {
    id: string;
    userId: string;
    expiresAt: string | Date;
    token: string;
  };
  user: AuthUser;
}

export interface MigrationStatus {
  user: AuthUser;
  storageKey: string | null;
  canonicalAlias: string | null;
  suggestedUsername: string | null;
  hasPassword: boolean;
  hasPasskey: boolean;
  hasTelegram: boolean;
  emailIsPlaceholder: boolean;
  needsCompletion: boolean;
  linkedProviders: string[];
  telegramUserId: string | null;
}

interface AuthMutationResponse {
  user: AuthUser;
  token?: string;
  needsCompletion?: boolean;
  storageKey?: string;
  completed?: boolean;
  linked?: boolean;
}

const authClient = createAuthClient({
  baseURL: AUTH_BASE_URL,
  plugins: [passkeyClient()],
  fetchOptions: {
    credentials: 'include',
    auth: {
      type: 'Bearer',
      token: () => getAuthToken() || undefined,
    },
    onSuccess(context) {
      captureAuthToken(context.response);
    },
    onResponse(context) {
      captureAuthToken(context.response);
      return context.response;
    },
  },
});

let currentSession: AuthSession | null = null;

function captureAuthToken(response: Response) {
  const token = response.headers.get('set-auth-token');
  if (token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  }
}

function toErrorMessage(message: unknown, fallback: string): string {
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }

  if (message && typeof message === 'object' && 'message' in message && typeof message.message === 'string') {
    return message.message;
  }

  return fallback;
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? JSON.parse(text) as T : (null as T);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const token = getAuthToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(resolveUrl(AUTH_BASE_URL, path), {
    ...init,
    headers,
    credentials: 'include',
  });

  captureAuthToken(response);

  if (response.status === 401) {
    clearAuthState();
  }

  if (!response.ok) {
    const payload = await parseJson<{ message?: string; error?: string } | null>(response).catch(() => null);
    throw new Error(payload?.message || payload?.error || 'Auth request failed');
  }

  return parseJson<T>(response);
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export function resolveApiUrl(path = ''): string {
  return resolveUrl(API_BASE_URL, path);
}

export function getAuthBaseUrl(): string {
  return AUTH_BASE_URL;
}

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function hasAuthToken(): boolean {
  return Boolean(getAuthToken());
}

export function getCurrentSession(): AuthSession | null {
  return currentSession;
}

export function getCurrentUser(): AuthUser | null {
  return currentSession?.user ?? null;
}

export function clearAuthState() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  currentSession = null;
}

export async function restoreSession(): Promise<AuthSession | null> {
  const result = await authClient.getSession({
    query: {
      disableRefresh: true,
    },
  });

  if (!result.error && result.data?.session && result.data.user) {
    currentSession = result.data as unknown as AuthSession;
    return currentSession;
  }

  currentSession = null;
  return null;
}

export function serializeTelegramLoginData(user: TelegramLoginData): string {
  const params = new URLSearchParams();
  Object.entries(user).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  });
  return params.toString();
}

export function canUsePasskeyInCurrentContext(): boolean {
  return 'PublicKeyCredential' in window;
}

export function openBrowserHandoff() {
  window.open(window.location.href, '_blank', 'noopener,noreferrer');
}

export async function signInWithEmail(email: string, password: string): Promise<AuthSession> {
  const result = await authClient.signIn.email({
    email,
    password,
  });

  if (result.error) {
    throw new Error(toErrorMessage(result.error.message, 'Не удалось войти'));
  }

  const session = await restoreSession();
  if (!session) {
    throw new Error('Не удалось восстановить сессию');
  }

  return session;
}

export async function signOut(): Promise<void> {
  await authClient.signOut();
  clearAuthState();
}

export async function signInWithPasskey(): Promise<AuthSession> {
  const result = await authClient.signIn.passkey();
  if (result.error) {
    throw new Error(toErrorMessage(result.error.message, 'Не удалось войти по Passkey'));
  }

  const session = await restoreSession();
  if (!session) {
    throw new Error('Не удалось восстановить сессию');
  }

  return session;
}

export async function addPasskey(name?: string): Promise<void> {
  const result = await authClient.passkey.addPasskey({
    name,
  });

  if (result.error) {
    throw new Error(toErrorMessage(result.error.message, 'Не удалось добавить Passkey'));
  }
}

export async function signInWithTelegram(initData: string): Promise<AuthMutationResponse> {
  const result = await requestJson<AuthMutationResponse>('/telegram/sign-in', {
    method: 'POST',
    body: JSON.stringify({ initData }),
  });
  await restoreSession();
  return result;
}

export async function linkTelegramAccount(initData: string): Promise<AuthMutationResponse> {
  const result = await requestJson<AuthMutationResponse>('/telegram/link', {
    method: 'POST',
    body: JSON.stringify({ initData }),
  });
  await restoreSession();
  return result;
}

export async function registerWithEmail(input: {
  email: string;
  password: string;
  username: string;
  name?: string;
}): Promise<AuthMutationResponse> {
  const result = await requestJson<AuthMutationResponse>('/register/email', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  await restoreSession();
  return result;
}

export async function completeMigration(input: {
  email: string;
  password: string;
  username: string;
  name?: string;
}): Promise<AuthMutationResponse> {
  const result = await requestJson<AuthMutationResponse>('/migration/complete', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  await restoreSession();
  return result;
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
  return requestJson<MigrationStatus>('/migration/status', {
    method: 'GET',
  });
}

export async function checkUsernameAvailability(username: string): Promise<boolean> {
  const result = await requestJson<{ available: boolean }>('/username/check', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  return result.available;
}

export async function authorizedApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getAuthToken();

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return fetch(resolveApiUrl(path), {
    ...init,
    headers,
    credentials: 'include',
  });
}
