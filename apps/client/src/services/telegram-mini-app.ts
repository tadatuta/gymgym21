interface TelegramWebApp {
  initData: string;
  ready(): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

let failed = false;
function ready(app: TelegramWebApp | null): TelegramWebApp | null {
  try { app?.ready(); return app; } catch { return null; }
}

let loading: Promise<TelegramWebApp | null> | undefined;

/** Bounded, shared SDK loading; never blocks the web/PWA bootstrap. */
export function loadTelegramWebApp(retry = false): Promise<TelegramWebApp | null> {
  const existing = window.Telegram?.WebApp;
  if (existing) {
    return Promise.resolve(ready(existing));
  }
  if (retry && failed) loading = undefined;
  if (loading) return loading;
  failed = false;
  loading = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js?63';
    script.async = true;
    const finish = (app: TelegramWebApp | null) => {
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      app = ready(app);
      failed = !app;
      if (!app) {
        script.remove();
      }
      resolve(app);
    };
    const timeout = setTimeout(() => finish(null), 4000);
    script.onload = () => finish(window.Telegram?.WebApp ?? null);
    script.onerror = () => finish(null);
    document.head.appendChild(script);
  });
  return loading;
}
