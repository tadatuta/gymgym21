# Gym21 Monorepo

`gym21` объединяет клиент и сервер в одном npm-workspaces репозитории.

## Структура

- `apps/client` — Vite/PWA клиент
- `apps/server` — Express + Better Auth backend
- `infra/nginx` — reverse proxy для single-origin docker-развёртывания
- `secrets` — локальная директория для внешних секретов, включая optional Google credentials

## Локальная разработка

Требования:

- Node.js 22 LTS
- npm 10+
- Docker Desktop или совместимый `docker compose`

Установка зависимостей:

```bash
npm install
```

Запуск по отдельности:

```bash
npm run dev:server
npm run dev:client
```

В dev-режиме клиент использует Vite proxy и ходит в backend через относительные `/api`-пути.

## Проверки

```bash
npm run typecheck
npm run test
npm run build
```

## Client HTML Safety

- Пользовательские строки нельзя вставлять в HTML-шаблоны напрямую: для текста используйте `escapeHtml`, для атрибутов `escapeAttribute`, для ссылок и изображений сначала `sanitizeUrl`.

## Offline-first

- После первого подтверждённого входа клиент сохраняет только несекретный descriptor аккаунта и открывает локальную IndexedDB до сетевой проверки сессии.
- Каждому `storageKey` соответствует отдельная IndexedDB; данные разных аккаунтов не смешиваются.
- Доменные изменения и запись в deduplicated outbox выполняются одной IndexedDB-транзакцией.
- Sync использует поколения outbox-записей, явные server acknowledgements, entity versions и постраничный pull. Изменение, сделанное во время запроса, не удаляется его устаревшим ответом.
- Конфликтующий локальный payload сохраняется и доступен для восстановления в разделе «Профиль → Данные».
- HttpOnly Better Auth cookie остаётся единственным источником сетевой авторизации. Токены и cookie не копируются в offline descriptor.
- Первый вход, синхронизация, Passkey/Telegram-операции и генерация новых AI-рекомендаций требуют сеть. Последние AI-результаты и ранее открытые публичные профили кэшируются внутри базы текущего аккаунта.

## Docker Deploy

1. Создать `.env` на основе `.env.example`.
2. При необходимости AI положить Google credentials в `./secrets/google-application-credentials.json`.
3. Поднять стек:

```bash
npm run docker:up
```

Сервисы:

- `proxy` — единая точка входа на `http://localhost:${APP_PORT}`
- `client` — статический SPA container
- `server` — Express API и auth
- `postgres` — единственное runtime-хранилище данных

Persistent data:

- `postgres_data` — данные Postgres

## Legacy Import

- Runtime работает только с PostgreSQL; file-backed storage и snapshot endpoints удалены.
- Для переноса старых JSON используйте отдельный importer:

```bash
npm run build --workspace @gym21/server
npm run import:storage-json --workspace @gym21/server -- --dir ./data/storage --dry-run --report ./import-report.json
npm run import:storage-json --workspace @gym21/server -- --dir ./data/storage --manifest ./import-manifest.json --apply --report ./import-report.json
```

- Importer поддерживает `--dry-run`, `--apply`, `--manifest`, `--skip-invalid`, `--truncate-storage`, `--report` и `--verbose`.
- `manifest` позволяет переопределить `storageKey` и сразу сделать upsert в `user_storage_binding`.

## Env Notes

- Для Docker `APP_BASE_URL`, `AUTH_BASE_URL` и `ALLOWED_ORIGINS` должны указывать на внешний origin proxy.
- `TRUST_PROXY` должен соответствовать реальной схеме reverse proxy, иначе IP-based rate limiting будет считать клиентов некорректно.
- Guardrails для чувствительных маршрутов настраиваются через `RATE_LIMIT_*`: отдельно для auth, username-check, storage/sync и AI.
- Backend требует валидный `DATABASE_URL`; PostgreSQL schema применяется migration runner-ом при старте.
- Для `POST /api/me/ai/recommendations` стоит держать консервативные `RATE_LIMIT_AI_*`, `AI_TIMEOUT_MS` и `AI_MAX_OUTPUT_TOKENS`, чтобы ограничивать burst-нагрузку и стоимость одного вызова.
- `AI_MAX_CONTEXT_CHARS`, `AI_MAX_RECENT_LOGS`, `AI_MAX_EXERCISE_COUNT` и `AI_TEXT_FIELD_MAX_LENGTH` ограничивают размер пользовательского контекста перед отправкой в модель.
- Browser-сессия опирается на secure Better Auth cookies; клиент не хранит bearer token в `localStorage` и не использует его как источник истины для auth.
- AI endpoint работает только при наличии корректного Vertex AI конфига и credentials; без них backend отвечает явной конфигурационной ошибкой.
- При превышении rate limit сервер возвращает `429 RATE_LIMIT_EXCEEDED`, а при конкурирующих дорогих запросах вроде AI/sync может вернуть `503 ROUTE_BUSY`.
- После обновления sync wire contract клиент и backend должны деплоиться вместе. Если браузер удерживает старый PWA shell, может понадобиться одноразовый refresh.
