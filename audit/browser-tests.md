# T05: переносимые браузерные проверки

Из корня, Node 22 из `.nvmrc` и отдельная PostgreSQL с правом создавать схемы:

```sh
npm ci
npm run test:browser:install
GYM21_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:browser
```

URL обязателен; нет fallback на `DATABASE_URL`. Каждая PG fixture создаёт UUID-схему и удаляет её в `finally`. Не используйте рабочую БД. `npm run test:browser` сначала собирает сервер/контракты, затем последовательно запускает семь fixtures с остановкой на первой ошибке. Для каждой отведено 240 секунд; при таймауте или сигнале runner завершает всю группу процессов SIGTERM, затем SIGKILL через 3 секунды. Обычный путь закрывает браузер, сервер, pool и удаляет временные сборки. Аварийный SIGKILL не гарантирует удаление SQL-схемы; в CI PostgreSQL service одноразовый.

Playwright 1.62.1 объявлен в root devDependencies; Vite и pg также объявлены там, поскольку audit runner использует их напрямую. Существующие версии пакетов сохранены. Chromium устанавливается отдельной командой. В Linux CI используется `npx playwright install --with-deps chromium`; `npm run test:browser` выполняется на Node 22/Ubuntu 24.04 с тем же синтетическим PostgreSQL 16 service после обязательной серверной интеграции. `PLAYWRIGHT_MODULE_PATH` и `PLAYWRIGHT_CHROMIUM_EXECUTABLE` остаются необязательными overrides для адресных локальных прогонов; стандартный запуск не требует глобальных пакетов или пользовательского Chrome.

| Fixture | Что проверяет |
| --- | --- |
| `auth-logout-browser.mjs` | Настоящий client auth/SDK + Express/Better Auth/PG: HttpOnly cookie A, два sign-out503, durable lock после reload, успешный retry удаляет cookie и SQL session, B login, stale A HTTP409 |
| `pwa-browser.mjs` | Настоящий production `main.ts`, существующие CSP и PWA plugin, реальный mounted API/PG: регистрация через UI; SW install/activation/control и Chrome installability; cached offline reload, локальное сохранение и автоматические restore/sync/outbox drain после online без reload; сохранение и отправка черновика при reconnect |
| `pwa-browser.mjs` | Реальный file chooser: offline merge/outbox, запрет offline replace без изменения данных; конкурентное изменение PG между preflight и backup → настоящий revision409 без потери сессии/данных, затем успешный atomic replace с tombstones |
| `pwa-browser.mjs` | Две настоящие main-вкладки: BroadcastChannel обновляет список, сохраняя ввод; смена общего cookie A→B, задержанный настоящий ответ A не очищает его inactive outbox и не попадает в B; reconnect исходной вкладки выбирает B и удаляет черновик A |
| `pwa-browser.mjs` | Временная production v2-сборка с изменённым HTML: настоящий `registration.update()`, новый SW, activation и автоматический reload, удаление старой precache revision; offline v2 navigation и сохранность IndexedDB/outbox с последующей отправкой |
| `training-time-browser.mjs` | Настоящие компоненты/IndexedDB: секунды, смена категории, перенос подхода, разные зоны, drafts main/settings/profile и disposal |
| `component-lifecycle-browser.mjs` | Настоящие компоненты/CSS: drag, Typeahead keyboard/ARIA, drafts и lifecycle/disposal |
| `cache-reconciliation-browser.mjs` | Две вкладки с настоящим IndexedDB и storage API: журнал изменений, cache reconciliation и изоляция аккаунтов |
| `sync-indicator-browser.mjs` | Настоящие UI/CSS индикатора, pointer interactions и retry |
| `public-guest-browser.mjs` | Настоящий main с синтетическими API: guest/paging/errors/back/login/stale responses без открытия личной IndexedDB |

`pwa-browser` не подменяет service worker, DOM приложения, auth API или алгоритм sync. Синтетически управляются только транспортные 503/задержка ответа и момент конкурентной серверной записи. Новая версия отличается HTML marker в отдельной временной сборке; конфигурация SW и autoUpdate — рабочие. Проверка installability выполнена Chrome DevTools Protocol, физический диалог ОС «На главный экран», iOS/Safari и Android не проверены.

Особенность Chromium 151 (также воспроизведена с системным Chrome): после offline-навигации через SW `context.setOffline(true)` продолжает блокировать транспорт, но `navigator.onLine` сбрасывается в `true`. Fixture восстанавливает состояние через сохраняемую CDP-сессию `Network.overrideNetworkState`; браузер сам генерирует online/offline events. Искусственные события SW/online и прямой вызов sync не используются. Утверждения проверяют native online event, статус navigator, серверные данные и настоящую очередь IndexedDB.

Найдена и исправлена ошибка: `authorizedApiFetch` считал любой 409 сменой аккаунта и сбрасывал сессию при `backup_revision_conflict` (также затрагивало `AI_CONTEXT_STALE`). Теперь 401 и явный `ACCOUNT_CONTEXT_MISMATCH` блокируют аккаунт, прочие 409 обрабатывает вызывающая операция. JSON читается из clone; после await повторно проверяется неизменность аккаунта. Unit-проверки покрывают recoverable/невалидный JSON, explicit mismatch и поздний mismatch body после выбора B; browser проверяет настоящий конфликт и повторный импорт.

Все данные синтетические; временный envDir исключает чтение workspace `.env`. Внешние origins блокируются; production SW кэширует локальные assets, API остаётся NetworkOnly. Официальные Telegram/Metrika scripts здесь не исполняются: отдельная CSP-проверка описана в [accessibility-csp](accessibility-csp.md). Большие 10k/100k performance fixtures, TLS и реальные внешние провайдеры в обычный browser suite не входят. Удалённый GitHub run не запускался, push не выполнялся.

Документация Playwright сверена через Context7: [browser installation](https://playwright.dev/docs/browsers), [service workers](https://playwright.dev/docs/service-workers). CDP network state проверен по установленному `playwright-core/types/protocol.d.ts`.

Итоговый локальный прогон T05: Node 22.23.2, Chromium 151.0.7922.34 (Playwright 1.62.1), PostgreSQL 16. Все 7 browser fixtures прошли без overrides. `npm run check`: contracts 9, client 208, server 101 passed / 1 отдельный TLS skip; typecheck/lint/build прошли. `npm ci --offline`, `npm ls --all`, `npm audit` (0 vulnerabilities), 6 отрицательных browser preflight и разбор/порядок CI workflow прошли.
