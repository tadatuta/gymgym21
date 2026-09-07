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
    <div class="page-content" style="display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px;">
      <div style="width:min(100%, 420px); background:rgba(255,255,255,0.98); border:1px solid rgba(0,0,0,0.08); border-radius:24px; padding:28px; box-shadow:0 24px 80px rgba(0,0,0,0.12);">
        <div style="display:flex; align-items:center; gap:14px; margin-bottom:20px;">
          <div style="width:52px; height:52px; border-radius:18px; background:linear-gradient(135deg, #151515, #4b4b4b); color:#fff; display:flex; align-items:center; justify-content:center; font-size:24px;">21</div>
          <div>
            <div style="font-size:28px; font-weight:700; line-height:1.1;">Жим-жим 21</div>
            <div style="color:#666; margin-top:4px;">Авторизация через Better Auth</div>
          </div>
        </div>
        ${note ? `<div style="margin-bottom:16px; padding:12px 14px; border-radius:14px; background:#f5f5f5; color:#333;">${escapeHtml(note)}</div>` : ''}
        ${content}
      </div>
    </div>
  `;
}

function renderStatus(message: string) {
  return `
    <div style="padding:18px; border-radius:18px; background:#f5f5f5; text-align:center;">
      <div style="font-size:15px; color:#444;">${escapeHtml(message)}</div>
    </div>
  `;
}

function renderAuthForm(mode: Exclude<LoginMode, 'complete'>, error?: string) {
  const isSignUp = mode === 'sign-up';

  return `
    <div style="display:flex; flex-direction:column; gap:16px;">
      <div style="display:flex; gap:8px;">
        <button id="auth-mode-sign-in" class="button ${!isSignUp ? '' : 'button_secondary'}" style="flex:1;">Вход</button>
        <button id="auth-mode-sign-up" class="button ${isSignUp ? '' : 'button_secondary'}" style="flex:1;">Регистрация</button>
      </div>

      ${error ? `<div style="padding:12px 14px; border-radius:14px; background:#fff1f1; color:#9d1c1c;">${escapeHtml(error)}</div>` : ''}

      <form id="email-auth-form" style="display:flex; flex-direction:column; gap:12px;">
        <input class="input" type="email" name="email" placeholder="Email" required>
        ${isSignUp ? '<input class="input" type="text" name="name" placeholder="Имя (опционально)">' : ''}
        ${isSignUp ? '<input class="input" type="text" name="username" placeholder="Username" required pattern="[A-Za-z0-9_]{5,32}">' : ''}
        <input class="input" type="password" name="password" placeholder="Пароль" required minlength="8">
        <button class="button" type="submit">${isSignUp ? 'Создать аккаунт' : 'Войти по email'}</button>
      </form>

      <div style="display:flex; align-items:center; gap:10px; color:#888;">
        <div style="flex:1; height:1px; background:#e5e5e5;"></div>
        <span style="font-size:13px;">или</span>
        <div style="flex:1; height:1px; background:#e5e5e5;"></div>
      </div>

      <button id="passkey-sign-in-btn" class="button button_secondary" type="button">Войти через Passkey</button>

      <div style="padding:16px; border-radius:18px; background:linear-gradient(180deg, #f8fbff, #eef6ff); border:1px solid rgba(0, 98, 255, 0.12);">
        <div style="font-weight:600; margin-bottom:10px;">Telegram</div>
        <div style="font-size:14px; color:#555; margin-bottom:12px;">Можно войти текущим Telegram-аккаунтом и привязать существующие данные.</div>
        <button id="telegram-mini-app-sign-in" class="button button_secondary" type="button">Войти в Telegram Mini App / повторить</button>
        <div id="telegram-login-container"></div>
      </div>
    </div>
  `;
}

function renderCompletionForm(prefill: { email?: string; username?: string | null; name?: string }) {
  return `
    <div style="display:flex; flex-direction:column; gap:16px;">
      <div>
        <div style="font-size:22px; font-weight:700; margin-bottom:8px;">Завершите миграцию</div>
        <div style="color:#666; line-height:1.5;">Нужно добавить email, пароль и app username, чтобы вход по паролю и Passkey работал вместе с вашим Telegram-аккаунтом.</div>
      </div>

      <form id="migration-complete-form" style="display:flex; flex-direction:column; gap:12px;">
        <input class="input" type="email" name="email" placeholder="Email" required value="${escapeAttribute(prefill.email || '')}">
        <input class="input" type="text" name="name" placeholder="Имя" value="${escapeAttribute(prefill.name || '')}">
        <input class="input" type="text" name="username" placeholder="Username" required pattern="[A-Za-z0-9_]{5,32}" value="${escapeAttribute(prefill.username || '')}">
        <input class="input" type="password" name="password" placeholder="Новый пароль" required minlength="8">
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
    `${error ? `<div style="margin-bottom:14px; padding:12px 14px; border-radius:14px; background:#fff1f1; color:#9d1c1c;">${escapeHtml(error)}</div>` : ''}
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
