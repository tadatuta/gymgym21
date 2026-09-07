import {
  addPasskey,
  cacheOfflineAccount,
  canUsePasskeyInCurrentContext,
  clearAuthState,
  getCurrentSession,
  getCurrentUser,
  getMigrationStatus,
  getOfflineAccount,
  hasActiveSession,
  hasVerifiedOnlineAccount,
  linkTelegramAccount,
  openBrowserHandoff,
  restoreSessionState,
  serializeTelegramLoginData,
  signOut,
  TELEGRAM_BOT_NAME
} from '../auth';
import { captureAccountContext } from '../db';
import { createRouterController } from '../router/controller';
import { createReconnectCoordinator } from '../services/reconnect';
import { loadTelegramWebApp } from '../services/telegram-mini-app';
import { storage } from '../storage/storage';
/** Production adapters; tests can supply the same interfaces without starting auth. */
export const defaultDependencies = {
  storage, captureAccountContext, loadTelegramWebApp, createReconnectCoordinator,
  createRouterController, addPasskey, cacheOfflineAccount, canUsePasskeyInCurrentContext,
  clearAuthState, getCurrentSession, getCurrentUser, getOfflineAccount, getMigrationStatus,
  hasActiveSession, hasVerifiedOnlineAccount, linkTelegramAccount, openBrowserHandoff,
  restoreSessionState, serializeTelegramLoginData, signOut, TELEGRAM_BOT_NAME,
};
export type UiDependencies = typeof defaultDependencies;
