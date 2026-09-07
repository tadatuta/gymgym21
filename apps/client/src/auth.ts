import { captureAccountContext, invalidateAccountOperations } from './db';
import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';

const DEFAULT_AUTH_BASE_URL = '/api/auth';
const LEGACY_AUTH_TOKEN_KEY = 'gym_auth_token';
const OFFLINE_ACCOUNTS_KEY = 'gym21_offline_accounts_v1';
const PENDING_SIGN_OUT_KEY = 'gym21_pending_sign_out_v1';

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

export interface OfflineAccount {
  storageKey: string;
  user: AuthUser;
  migrationStatus: MigrationStatus;
  lastValidatedAt: string;
}

interface OfflineAccountRegistry {
  version: 1;
  activeStorageKey: string | null;
  accounts: Record<string, OfflineAccount>;
}

export type SessionRestoreState =
  | { status: 'authenticated'; session: AuthSession }
  | { status: 'unauthenticated' }
  | { status: 'unavailable'; error?: unknown };

interface AuthMutationResponse {
  user: AuthUser;
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
  },
});

let currentSession: AuthSession | null = null;
let currentOfflineAccount: OfflineAccount | null = null;
let authGeneration = 0;
let logoutIntent = 0;
const authChannel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('gym21-auth-v1') : null;
function invalidateAuth(broadcast = true) {
  authGeneration += 1;
  invalidateAccountOperations();
  if (broadcast) authChannel?.postMessage({ type: 'auth-changed' });
}
if (authChannel) authChannel.onmessage = (event) => {
  if (event.data?.type !== 'auth-changed') return;
  logoutIntent += 1;
  invalidateAuth(false);
  currentSession = null;
  currentOfflineAccount = null;
  window.dispatchEvent(new Event('gym21-auth-changed'));
};

// Serialize cookie mutations, including across same-origin tabs where Web Locks exists.
// Ignoring a stale response body cannot undo its Set-Cookie header.
let authMutationTail: Promise<unknown> = Promise.resolve();
function withAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => typeof navigator !== 'undefined' && navigator.locks
    ? await navigator.locks.request('gym21-auth-cookie-mutation', operation)
    : operation();
  const result = authMutationTail.then(run, run);
  authMutationTail = result.catch(() => undefined);
  return result;
}

let memoryPendingSignOut: string | null = null;
function pendingSignOut(): string | null {
  return typeof localStorage === 'undefined' ? memoryPendingSignOut : localStorage.getItem(PENDING_SIGN_OUT_KEY);
}

async function completePendingSignOut(): Promise<void> {
  const marker = pendingSignOut();
  if (!marker) return;
  const result = await authClient.signOut();
  if (result.error || result.data?.success !== true) {
    throw new Error(toErrorMessage(result.error, 'Не удалось завершить выход из аккаунта'));
  }
  if (pendingSignOut() === marker) {
    memoryPendingSignOut = null;
    if (typeof localStorage !== 'undefined') localStorage.removeItem(PENDING_SIGN_OUT_KEY);
  }
}

function withSignInMutation<T>(operation: () => Promise<T>): Promise<T> {
  const intent = logoutIntent;
  return withAuthMutation(async () => {
    if (intent !== logoutIntent) throw new Error('Stale auth operation');
    return operation();
  });
}

async function beginSignIn(): Promise<void> {
  // Never replay an older logout after a new cookie has been issued.
  const intent = logoutIntent;
  await completePendingSignOut();
  if (intent !== logoutIntent) throw new Error('Stale auth operation');
  invalidateAuth();
}

function emptyOfflineAccountRegistry(): OfflineAccountRegistry {
  return {
    version: 1,
    activeStorageKey: null,
    accounts: {},
  };
}

function readOfflineAccountRegistry(): OfflineAccountRegistry {
  if (typeof localStorage === 'undefined') {
    return emptyOfflineAccountRegistry();
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(OFFLINE_ACCOUNTS_KEY) || 'null') as Partial<OfflineAccountRegistry> | null;
    if (parsed?.version !== 1 || typeof parsed.accounts !== 'object' || parsed.accounts === null) {
      return emptyOfflineAccountRegistry();
    }

    return {
      version: 1,
      activeStorageKey: typeof parsed.activeStorageKey === 'string' ? parsed.activeStorageKey : null,
      accounts: parsed.accounts as Record<string, OfflineAccount>,
    };
  } catch {
    return emptyOfflineAccountRegistry();
  }
}

function writeOfflineAccountRegistry(registry: OfflineAccountRegistry) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(OFFLINE_ACCOUNTS_KEY, JSON.stringify(registry));
}

function loadActiveOfflineAccount(): OfflineAccount | null {
  const registry = readOfflineAccountRegistry();
  if (!registry.activeStorageKey) {
    return null;
  }

  const account = registry.accounts[registry.activeStorageKey];
  if (
    !account
    || typeof account.storageKey !== 'string'
    || !account.user
    || !account.migrationStatus
    || account.migrationStatus.needsCompletion
  ) {
    return null;
  }

  return account;
}

function purgeLegacyAuthToken() {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
  } catch {
    // Ignore storage access issues and continue with cookie-backed auth.
  }
}

purgeLegacyAuthToken();
currentOfflineAccount = pendingSignOut() ? null : loadActiveOfflineAccount();

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

  const requestGeneration = authGeneration;
  const response = await fetch(resolveUrl(AUTH_BASE_URL, path), {
    ...init,
    headers,
    credentials: 'include',
  });

  if (requestGeneration !== authGeneration) throw new Error('Stale auth operation');
  if (response.status === 401) {
    clearAuthState();
  }

  if (!response.ok) {
    const payload = await parseJson<{ message?: string; error?: string } | null>(response).catch(() => null);
    throw new Error(payload?.message || payload?.error || 'Auth request failed');
  }

  const payload = await parseJson<T>(response);
  if (requestGeneration !== authGeneration) throw new Error('Stale auth operation');
  return payload;
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

export function hasActiveSession(): boolean {
  return Boolean(currentSession?.session && currentSession.user);
}

export function hasOfflineAccount(): boolean {
  return currentOfflineAccount !== null;
}

export function hasVerifiedOnlineAccount(storageKey?: string | null): boolean {
  if (!currentSession?.user || !currentOfflineAccount) {
    return false;
  }

  return currentSession.user.id === currentOfflineAccount.user.id
    && (!storageKey || currentOfflineAccount.storageKey === storageKey);
}

export function getCurrentSession(): AuthSession | null {
  return currentSession;
}

export function getCurrentUser(): AuthUser | null {
  return currentSession?.user ?? currentOfflineAccount?.user ?? null;
}

export function getOfflineAccount(): OfflineAccount | null {
  return currentOfflineAccount;
}

export function getActiveStorageKey(): string | null {
  return currentOfflineAccount?.storageKey ?? null;
}

export function cacheOfflineAccount(user: AuthUser, migrationStatus: MigrationStatus): OfflineAccount {
  if (!migrationStatus.storageKey) {
    throw new Error('Authenticated account does not have a storage key');
  }

  const account: OfflineAccount = {
    storageKey: migrationStatus.storageKey,
    user,
    migrationStatus,
    lastValidatedAt: new Date().toISOString(),
  };
  const registry = readOfflineAccountRegistry();
  registry.accounts[account.storageKey] = account;
  registry.activeStorageKey = account.storageKey;
  writeOfflineAccountRegistry(registry);
  if (currentOfflineAccount?.storageKey !== account.storageKey) invalidateAuth(false);
  currentOfflineAccount = account;
  return account;
}

export function clearOfflineAccountSelection() {
  const registry = readOfflineAccountRegistry();
  registry.activeStorageKey = null;
  writeOfflineAccountRegistry(registry);
  currentOfflineAccount = null;
}

export function clearAuthState(options: { clearOfflineAccount?: boolean; broadcast?: boolean } = {}) {
  invalidateAuth(options.broadcast ?? true);
  purgeLegacyAuthToken();
  currentSession = null;
  if (options.clearOfflineAccount ?? true) {
    clearOfflineAccountSelection();
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('gym21-auth-changed'));
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined;
  }

  return typeof error.status === 'number' ? error.status : undefined;
}

export async function restoreSessionState(): Promise<SessionRestoreState> {
  if (pendingSignOut()) return withAuthMutation(restoreSessionStateUnlocked);
  return restoreSessionStateUnlocked();
}

async function restoreSessionStateUnlocked(): Promise<SessionRestoreState> {
  const requestGeneration = authGeneration;
  purgeLegacyAuthToken();

  try {
    if (pendingSignOut()) {
      currentSession = null;
      clearOfflineAccountSelection();
      await completePendingSignOut();
      if (requestGeneration !== authGeneration) return { status: 'unavailable', error: new Error('Stale auth operation') };
      return { status: 'unauthenticated' };
    }

    const result = await authClient.getSession({
      query: {
        disableRefresh: true,
      },
    });

    if (requestGeneration !== authGeneration) return { status: 'unavailable', error: new Error('Stale auth operation') };
    if (!result.error && result.data?.session && result.data.user) {
      if (currentSession?.user.id !== result.data.user.id) invalidateAuth(false);
      currentSession = result.data as unknown as AuthSession;
      return { status: 'authenticated', session: currentSession };
    }

    const errorStatus = getErrorStatus(result.error);
    if (!result.error || errorStatus === 401 || errorStatus === 403) {
      currentSession = null;
      return { status: 'unauthenticated' };
    }

    currentSession = null;
    return { status: 'unavailable', error: result.error };
  } catch (error) {
    if (requestGeneration === authGeneration) currentSession = null;
    return { status: 'unavailable', error };
  }
}

export async function restoreSession(): Promise<AuthSession | null> {
  const state = await restoreSessionState();
  return state.status === 'authenticated' ? state.session : null;
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
  return withSignInMutation(async () => {
    await beginSignIn();
    const requestGeneration = authGeneration;
    const result = await authClient.signIn.email({
      email,
      password,
  });

  if (requestGeneration !== authGeneration) throw new Error('Stale auth operation');
  if (result.error) {
    throw new Error(toErrorMessage(result.error.message, 'Не удалось войти'));
  }

  invalidateAuth();
  const session = await restoreSessionStateUnlocked().then(state => state.status === 'authenticated' ? state.session : null);
  if (!session) {
    throw new Error('Не удалось восстановить сессию');
  }

  return session;
  });
}

export async function signOut(): Promise<void> {
  logoutIntent += 1;
  // Persist intent and lock local identity before waiting for any network operation.
  memoryPendingSignOut = crypto.randomUUID();
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(PENDING_SIGN_OUT_KEY, memoryPendingSignOut);
  }
  clearAuthState({ clearOfflineAccount: true });
  await withAuthMutation(async () => {
    try {
      await completePendingSignOut();
    } catch {
      console.warn('Server sign-out unavailable; local account locked, retry pending');
    }
  });
}

export async function signInWithPasskey(): Promise<AuthSession> {
  return withSignInMutation(async () => {
    await beginSignIn();
    const requestGeneration = authGeneration;
    const result = await authClient.signIn.passkey();
    if (requestGeneration !== authGeneration) throw new Error('Stale auth operation');
    if (result.error) {
      throw new Error(toErrorMessage(result.error.message, 'Не удалось войти по Passkey'));
    }

    invalidateAuth();
    const session = await restoreSessionStateUnlocked().then(state => state.status === 'authenticated' ? state.session : null);
    if (!session) {
      throw new Error('Не удалось восстановить сессию');
    }

    return session;
  });
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
  return withSignInMutation(async () => {
    await beginSignIn();
    const result = await requestJson<AuthMutationResponse>('/telegram/sign-in', {
      method: 'POST',
      body: JSON.stringify({ initData }),
  });
  invalidateAuth();
  const session = await restoreSessionStateUnlocked().then(state => state.status === 'authenticated' ? state.session : null);
  if (!session || session.user.id !== result.user.id) throw new Error('Stale auth operation');
  return result;
  });
}

export async function linkTelegramAccount(initData: string): Promise<AuthMutationResponse> {
  return withSignInMutation(async () => {
    await beginSignIn();
    const result = await requestJson<AuthMutationResponse>('/telegram/link', {
      method: 'POST',
      body: JSON.stringify({ initData }),
  });
  invalidateAuth();
  const session = await restoreSessionStateUnlocked().then(state => state.status === 'authenticated' ? state.session : null);
  if (!session || session.user.id !== result.user.id) throw new Error('Stale auth operation');
  return result;
  });
}

export async function registerWithEmail(input: {
  email: string;
  password: string;
  username: string;
  name?: string;
}): Promise<AuthMutationResponse> {
  return withSignInMutation(async () => {
    await beginSignIn();
    const result = await requestJson<AuthMutationResponse>('/register/email', {
      method: 'POST',
      body: JSON.stringify(input),
  });
  invalidateAuth();
  const session = await restoreSessionStateUnlocked().then(state => state.status === 'authenticated' ? state.session : null);
  if (!session || session.user.id !== result.user.id) throw new Error('Stale auth operation');
  return result;
  });
}

export async function completeMigration(input: {
  email: string;
  password: string;
  username: string;
  name?: string;
}): Promise<AuthMutationResponse> {
  return withSignInMutation(async () => {
    await beginSignIn();
    const result = await requestJson<AuthMutationResponse>('/migration/complete', {
      method: 'POST',
      body: JSON.stringify(input),
  });
  invalidateAuth();
  const session = await restoreSessionStateUnlocked().then(state => state.status === 'authenticated' ? state.session : null);
  if (!session || session.user.id !== result.user.id) throw new Error('Stale auth operation');
  return result;
  });
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

export async function authorizedApiFetch(path: string, init: RequestInit = {}, context = captureAccountContext()): Promise<Response> {
  context.assertCurrent();
  if (!context.storageKey || !hasVerifiedOnlineAccount(context.storageKey)) throw new Error('Unauthorized');
  const headers = new Headers(init.headers);
  headers.set('X-Expected-Storage-Key', context.storageKey);
  const response = await fetch(resolveApiUrl(path), {
    ...init, headers, signal: init.signal ? AbortSignal.any([init.signal, context.signal]) : context.signal, credentials: 'include',
  });
  context.assertCurrent();
  if (init.signal?.aborted) throw init.signal.reason;
  if (response.status === 401 || response.status === 409) clearAuthState({ clearOfflineAccount: true });
  return response;
}
