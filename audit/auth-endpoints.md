# T04 — настоящие auth endpoints

Проверка от 8 сентября 2026. `apps/server/test/auth-http.test.js` запускает production `createApp`, `createAuthNodeHandler` (Better Auth 1.6.30), `resolveRequestContext` и общий PostgreSQL repository. HTTP проходит Express mounting; cookies берутся только из настоящего `Set-Cookie`. Тест не извлекает SQL token для входа и не подменяет resolver.

| Требование аудита | Проверка и доказательство |
| --- | --- |
| Placeholder email | HTTP custom/standard signup отвергают зарезервированный домен с пробелами/регистром, invalid Telegram proof возвращает 401, без cookies и изменений user/account/session/alias/binding. Дополнительные migration/change/update и legacy occupied-placeholder 409 находятся в `auth-email.test.js`. |
| Владение alias | HTTP concurrent signup оставляет один user/credential/canonical alias/storage binding/session; обе регистрации удерживаются PostgreSQL advisory barrier **после** availability prechecks, до INSERT. Проверки auth/public namespace и forged sync identity находятся в `identity.test.js`. |
| Конкурентная регистрация | Дополнительно две регистрации с одинаковым email/разными aliases дают ровно 200/400 и не оставляют orphan rows. Barrier username race обнаружил прежний 500: теперь только SQLSTATE 23505 + table `user` + точные `user_email_key`/`user_username_key` после rollback преобразуются в прежний пользовательский 400. Unexpected SQL error всё ещё даёт 500 и полностью откатывается. |
| Link Telegram | Синтетический Telegram payload подписывается стандартным HMAC и проверяется настоящим серверным verifier. Владелец связывает provider; другой cookie account и invalid proof не меняют identity tables, сессии и обе storage snapshots. Неавторизованный link — 401. Повторный Telegram login выпускает настоящую cookie исходного владельца. |
| Logout при resolved 503 | `auth-logout-browser.mjs`: настоящий Chromium, клиентский `auth.ts` и Better Auth SDK, настоящий mounted HTTP API и PostgreSQL. A получает HttpOnly cookie/SQL session и offline selection; первая ошибка sign-out 503 сохраняет серверную сессию, но блокирует локальный аккаунт. После reload pending-marker блокирует восстановление; повторный 503 при restore возвращает unavailable, cookie/session ещё живы. Следующий restore вызывает настоящий sign-out: SQL session и cookie удалены, состояние unauthenticated. Регистрация B получает собственную cookie; устаревший A storage context отвергнут 409, snapshot A неизменён, старый logout не повторяется над B. |

Дополнительные существующие проверки: `auth-email.test.js` проверяет Passkey options/list/401 и атомарный rollback при вторичном alias failure; `auth-sdk.test.ts` — rejected и resolved SDK errors, serialize/Web Locks, новые logout intents. Эти проверки дополняют, а не заменяют настоящее HTTP/browser покрытие.

## Воспроизведение

Нужны Node 22, `npm ci`, отдельная PostgreSQL 16 и `GYM21_TEST_DATABASE_URL` с явными host/database. Рабочие `.env` не читаются, `DATABASE_URL` не используется как fallback. Каждая проверка создаёт UUID-схему и удаляет её вместе с закрытием pool. Auth secrets и аккаунты синтетические; общую тестовую PostgreSQL сценарии не останавливают.

```sh
npm run build --workspace @gym21/server
node --test apps/server/test/auth-http.test.js
npm run test:integration
```

Для browser fixture нужен Playwright с Chromium. T05 объявляет Playwright в проекте: `npm run test:browser:install`. Fixture входит в `npm run test:browser`; для отдельного запуска можно использовать стандартный Chromium либо явно заданные пути:

```sh
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
node audit/auth-logout-browser.mjs
```

Fixture прерывается сразу после неуспешного PostgreSQL preflight, до создания pool или загрузки Playwright. Отдельно проверены missing/invalid/wrong-protocol URL с trap на PostgreSQL query/connect и отсутствующим Playwright path: exit 1, ни один trap не вызван. Vite работает с пустым временным envDir и без пользовательского config; браузер блокирует внешние origins. Подменяются только первые два HTTP ответа `/sign-out` на 503. Все остальные auth requests и cookies настоящие; искусственный сервер auth не используется.

## Результат и границы

Целевой HTTP suite: 6 passed, 0 skipped. Chromium сценарий прошёл с настоящей PostgreSQL; повторный 503 после reload также проверен. Server typecheck/ESLint и полный explicit integration — см. итоговую строку T04 в `AUDIT_PROGRESS.md`.

HTTP suite входит в `npm test` (без URL явно skipped) и обязательный CI `test:integration` с PostgreSQL service. Browser fixture включён в [переносимый T05 suite и CI](browser-tests.md); унификация исторических fixtures — T06. Физическая Passkey ceremony, настоящий Telegram, production TLS cookies и hosted GitHub runner этой проверкой не заявляются. Rate limits отключены только в изолированном fixture для проверки auth ownership; общий limiter проверяется отдельно в O05.

Подключение Express сверено через Context7 с [официальным Better Auth v1.6.23](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/integrations/express.mdx) — ближайшей доступной документированной версией к установленной 1.6.30 — и текущими production `createApp`/`createAuthNodeHandler`: auth handler подключён до JSON middleware.
