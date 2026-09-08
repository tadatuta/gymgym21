import {
  TelegramLoginData,
  canAutoSignInWithTelegram,
  captureAuthGuard,
  getOfflineAccount,
  canUsePasskeyInCurrentContext,
  completeMigration,
  getCurrentSession,
  getMigrationStatus,
  openBrowserHandoff,
  registerWithEmail,
  restoreSession,
  serializeTelegramLoginData,
  signInWithEmail,
  signInWithPasskey,
  signInWithTelegram,
  TELEGRAM_BOT_NAME,
} from '../../auth';
import { loadTelegramWebApp } from '../../services/telegram-mini-app';
import { escapeAttribute, escapeHtml } from '../../utils/safe-html';

declare global {
  interface Window {
    onTelegramAuthBetter: (user: TelegramLoginData) => void;
  }
}

const loginRenders = new WeakMap<HTMLElement, object>();
type IsCurrent = () => boolean;

/** The router takes ownership of this container; pending login callbacks must stop. */
export function disposeLogin(container: HTMLElement): void {
  loginRenders.delete(container);
}

type LoginMode = 'sign-in' | 'sign-up' | 'complete';

function renderShell(container: HTMLElement, content: string, note?: string) {
  container.innerHTML = `
    <div class="auth page-content">
      <div class="auth__card">
        <div class="auth__header">
          <div class="auth__logo">21</div>
          <div>
            <div class="auth__title">Жим-жим 21</div>
            <div class="auth__subtitle">Авторизация через Better Auth</div>
          </div>
        </div>
        ${note ? `<div class="auth__note">${escapeHtml(note)}</div>` : ''}
        ${content}
      </div>
    </div>
  `;
}

function renderStatus(message: string) {
  return `
    <div class="auth__status">
      <div class="auth__status-text">${escapeHtml(message)}</div>
    </div>
  `;
}

function renderAuthForm(mode: Exclude<LoginMode, 'complete'>, error?: string) {
  const isSignUp = mode === 'sign-up';

  return `
    <div class="auth__content">
      <div class="form-actions">
        <button id="auth-mode-sign-in" class="form-actions__button button ${!isSignUp ? '' : 'button_secondary'}">Вход</button>
        <button id="auth-mode-sign-up" class="form-actions__button button ${isSignUp ? '' : 'button_secondary'}">Регистрация</button>
      </div>

      ${error ? `<div class="auth__error">${escapeHtml(error)}</div>` : ''}

      <form id="email-auth-form" class="form-stack">
        <label class="label" for="auth-email">Email</label><input class="input" type="email" name="email" id="auth-email" autocomplete="email" placeholder="Email" required>
        ${isSignUp ? '<label class="label" for="auth-name">Имя</label><input class="input" type="text" name="name" id="auth-name" autocomplete="name" placeholder="Имя (опционально)">' : ''}
        ${isSignUp ? '<label class="label" for="auth-username">Username</label><input class="input" type="text" name="username" id="auth-username" autocomplete="username" placeholder="Username" required pattern="[A-Za-z0-9_]{5,32}">' : ''}
        <label class="label" for="auth-password">Пароль</label><input class="input" type="password" name="password" id="auth-password" autocomplete="${isSignUp ? 'new-password' : 'current-password'}" placeholder="Пароль" required minlength="8">
        <button class="button" type="submit">${isSignUp ? 'Создать аккаунт' : 'Войти по email'}</button>
      </form>

      <div class="auth__separator">
        <div class="auth__separator-line"></div>
        <span class="auth__separator-label">или</span>
        <div class="auth__separator-line"></div>
      </div>

      <button id="passkey-sign-in-btn" class="button button_secondary" type="button">Войти через Passkey</button>

      <div class="auth__telegram">
        <div class="auth__telegram-title">Telegram</div>
        <div class="auth__telegram-description">Можно войти текущим Telegram-аккаунтом и привязать существующие данные.</div>
        <button id="telegram-mini-app-sign-in" class="button button_secondary" type="button">Войти в Telegram Mini App / повторить</button>
        <div id="telegram-login-container"></div>
      </div>
    </div>
  `;
}

function renderCompletionForm(prefill: { email?: string; username?: string | null; name?: string }) {
  return `
    <div class="auth__content">
      <div>
        <div class="auth__migration-title">Завершите миграцию</div>
        <div class="auth__migration-description">Нужно добавить email, пароль и app username, чтобы вход по паролю и Passkey работал вместе с вашим Telegram-аккаунтом.</div>
      </div>

      <form id="migration-complete-form" class="form-stack">
        <label class="label" for="auth-email">Email</label><input class="input" type="email" name="email" id="auth-email" autocomplete="email" placeholder="Email" required value="${escapeAttribute(prefill.email || '')}">
        <label class="label" for="auth-name">Имя</label><input class="input" type="text" name="name" id="auth-name" autocomplete="name" placeholder="Имя" value="${escapeAttribute(prefill.name || '')}">
        <label class="label" for="auth-username">Username</label><input class="input" type="text" name="username" id="auth-username" autocomplete="username" placeholder="Username" required pattern="[A-Za-z0-9_]{5,32}" value="${escapeAttribute(prefill.username || '')}">
        <label class="label" for="auth-password">Пароль</label><input class="input" type="password" name="password" id="auth-password" autocomplete="new-password" placeholder="Новый пароль" required minlength="8">
        <button class="button" type="submit">Завершить миграцию</button>
      </form>
    </div>
  `;
}

async function showCompletionForm(container: HTMLElement, onLoginSuccess: () => void, isCurrent: IsCurrent, error?: string) {
  const session = getCurrentSession();
  const status = await getMigrationStatus();
  if (!isCurrent() || session !== getCurrentSession()) return;
  renderShell(
    container,
    `${error ? `<div class="auth__error auth__error_spaced">${escapeHtml(error)}</div>` : ''}
     ${renderCompletionForm({
       email: status.emailIsPlaceholder ? '' : status.user.email,
       username: status.user.username || status.suggestedUsername || '',
       name: status.user.name,
     })}`,
  );

  const form = container.querySelector('#migration-complete-form') as HTMLFormElement | null;
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isCurrent() || !form.isConnected) return;
    const formData = new FormData(form);

    try {
      renderShell(container, renderStatus('Сохраняем настройки аккаунта...'));
      await completeMigration({
        email: String(formData.get('email') || ''),
        name: String(formData.get('name') || ''),
        username: String(formData.get('username') || ''),
        password: String(formData.get('password') || ''),
      });
      if (isCurrent()) onLoginSuccess();
    } catch (submitError) {
      if (isCurrent()) await showCompletionForm(container, onLoginSuccess, isCurrent, submitError instanceof Error ? submitError.message : String(submitError));
    }
  });
}

async function finalizeAuth(container: HTMLElement, onLoginSuccess: () => void, isCurrent: IsCurrent) {
  if (!isCurrent()) return;
  const session = getCurrentSession();
  const status = await getMigrationStatus();
  if (!isCurrent() || session !== getCurrentSession()) return;
  if (status.needsCompletion) {
    await showCompletionForm(container, onLoginSuccess, isCurrent);
    return;
  }

  onLoginSuccess();
}

async function handleTelegramAuth(container: HTMLElement, initData: string, onLoginSuccess: () => void, isCurrent: IsCurrent, automatic = false) {
  if (!isCurrent()) return;
  renderShell(container, renderStatus('Подключаем Telegram-аккаунт...'));
  await signInWithTelegram(initData, automatic);
  await finalizeAuth(container, onLoginSuccess, isCurrent);
}

function mountTelegramWidget(container: HTMLElement, onLoginSuccess: () => void, isCurrent: IsCurrent, onStart: () => void) {
  const mountNode = container.querySelector('#telegram-login-container');
  if (!mountNode) return;

  window.onTelegramAuthBetter = async (user: TelegramLoginData) => {
    if (!isCurrent() || !mountNode.isConnected) return;
    onStart();
    try {
      await handleTelegramAuth(container, serializeTelegramLoginData(user), onLoginSuccess, isCurrent);
    } catch (error) {
      if (isCurrent()) await renderLogin(container, onLoginSuccess, error instanceof Error ? error.message : String(error));
    }
  };

  const script = document.createElement('script');
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.async = true;
  script.setAttribute('data-telegram-login', TELEGRAM_BOT_NAME);
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-radius', '12');
  script.setAttribute('data-onauth', 'onTelegramAuthBetter(user)');
  script.setAttribute('data-request-access', 'write');
  mountNode.appendChild(script);
}

export async function renderLogin(container: HTMLElement, onLoginSuccess: () => void, error?: string) {
  const renderToken = {};
  loginRenders.set(container, renderToken);
  const isCurrent = () => loginRenders.get(container) === renderToken && container.isConnected;
  const authGuard = captureAuthGuard();
  let actionStarted = false;
  let interacted = false;
  const restoredSession = await restoreSession();
  if (!isCurrent()) return;
  if (restoredSession || getCurrentSession()) {
    try {
      await finalizeAuth(container, onLoginSuccess, isCurrent);
      return;
    } catch {
      // Fall through to auth screen if session restore is stale.
    }
  }

  if (!authGuard()) return;
  renderShell(container, renderAuthForm('sign-in', error));

  let currentMode: Exclude<LoginMode, 'complete'> = 'sign-in';

  const rerenderMode = async (nextMode: Exclude<LoginMode, 'complete'>, nextError?: string) => {
    if (!isCurrent()) return;
    currentMode = nextMode;
    renderShell(container, renderAuthForm(currentMode, nextError));
    actionStarted = false;
    bindEvents();
  };

  const bindEvents = () => {
    mountTelegramWidget(container, onLoginSuccess, isCurrent, () => { actionStarted = true; interacted = true; });
    container.querySelector('#telegram-mini-app-sign-in')?.addEventListener('click', async () => {
      if (actionStarted || !isCurrent()) return;
      actionStarted = true; interacted = true;
      try {
        const guard = captureAuthGuard();
        const app = await loadTelegramWebApp(true);
        if (!isCurrent() || !guard()) return;
        if (!app?.initData) throw new Error('Откройте приложение через Telegram. Если вход истёк, закройте Mini App и откройте заново. В браузере используйте виджет или email.');
        await handleTelegramAuth(container, app.initData, onLoginSuccess, isCurrent);
      } catch (error) {
        if (isCurrent()) await rerenderMode(currentMode, error instanceof Error ? error.message : String(error));
      } finally { actionStarted = false; }
    });

    container.querySelector('#auth-mode-sign-in')?.addEventListener('click', async () => {
      interacted = true;
      await rerenderMode('sign-in');
    });

    container.querySelector('#auth-mode-sign-up')?.addEventListener('click', async () => {
      interacted = true;
      await rerenderMode('sign-up');
    });


    container.querySelector('#passkey-sign-in-btn')?.addEventListener('click', async () => {
      if (!isCurrent()) return;
      actionStarted = true; interacted = true;
      if (!canUsePasskeyInCurrentContext()) {
        openBrowserHandoff();
        actionStarted = false;
        return;
      }

      try {
        renderShell(container, renderStatus('Проверяем Passkey...'));
        await signInWithPasskey();
        await finalizeAuth(container, onLoginSuccess, isCurrent);
      } catch (passkeyError) {
        await rerenderMode(currentMode, passkeyError instanceof Error ? passkeyError.message : String(passkeyError));
      }
    });

    const form = container.querySelector('#email-auth-form') as HTMLFormElement | null;
    form?.addEventListener('input', () => { interacted = true; });
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!isCurrent() || !form.isConnected || actionStarted) return;
      actionStarted = true; interacted = true;
      const formData = new FormData(form);

      try {
        renderShell(container, renderStatus(currentMode === 'sign-up' ? 'Создаём аккаунт...' : 'Входим в аккаунт...'));
        if (currentMode === 'sign-up') {
          await registerWithEmail({
            email: String(formData.get('email') || ''),
            name: String(formData.get('name') || ''),
            username: String(formData.get('username') || ''),
            password: String(formData.get('password') || ''),
          });
        } else {
          await signInWithEmail(
            String(formData.get('email') || ''),
            String(formData.get('password') || ''),
          );
        }

        await finalizeAuth(container, onLoginSuccess, isCurrent);
      } catch (submitError) {
        await rerenderMode(currentMode, submitError instanceof Error ? submitError.message : String(submitError));
      }
    });
  };

  bindEvents();
  // Render usable email/passkey/widget controls before waiting for the optional SDK.
  if (!error && !getOfflineAccount() && canAutoSignInWithTelegram()) {
    const app = await loadTelegramWebApp();
    if (!isCurrent() || !authGuard() || interacted || actionStarted || !canAutoSignInWithTelegram() || !app?.initData) return;
    actionStarted = true; interacted = true;
    try {
      await handleTelegramAuth(container, app.initData, onLoginSuccess, isCurrent, true);
    } catch (error) {
      if (isCurrent()) await rerenderMode(currentMode, `${error instanceof Error ? error.message : String(error)}. Повторите вход вручную; если данные истекли, откройте Mini App заново.`);
    }
  }
}
