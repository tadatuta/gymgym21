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

## Docker Deploy

1. Создать `.env` на основе `.env.example`.
2. Для файлового storage создать локальную директорию `./data/storage` и положить туда существующие JSON-файлы вида `<storageKey>.json`.
3. При необходимости AI положить Google credentials в `./secrets/google-application-credentials.json`.
4. Поднять стек:

```bash
npm run docker:up
```

Сервисы:

- `proxy` — единая точка входа на `http://localhost:${APP_PORT}`
- `client` — статический SPA container
- `server` — Express API и auth
- `postgres` — auth/meta database

Persistent data:

- `postgres_data` — данные Postgres
- `./data/storage` — файловый storage backend при локальном запуске

Для Docker backend всегда читает storage из `/data/storage` внутри контейнера.
По умолчанию compose монтирует туда `./data/storage`, а на продакшене можно переопределить host-путь через `STORAGE_HOST_DIR`, например `/srv/gym21/storage`.
`STORAGE_DIR` должен оставаться путём внутри контейнера и обычно равен `/data/storage`.

## Env Notes

- Для Docker `APP_BASE_URL`, `AUTH_BASE_URL` и `ALLOWED_ORIGINS` должны указывать на внешний origin proxy.
- `TRUST_PROXY` должен соответствовать реальной схеме reverse proxy, иначе IP-based rate limiting будет считать клиентов некорректно.
- Guardrails для чувствительных маршрутов настраиваются через `RATE_LIMIT_*`: отдельно для auth, username-check, storage/sync и AI.
- Для `POST /api/me/ai/recommendations` стоит держать консервативные `RATE_LIMIT_AI_*`, `AI_TIMEOUT_MS` и `AI_MAX_OUTPUT_TOKENS`, чтобы ограничивать burst-нагрузку и стоимость одного вызова.
- `AI_MAX_CONTEXT_CHARS`, `AI_MAX_RECENT_LOGS`, `AI_MAX_EXERCISE_COUNT` и `AI_TEXT_FIELD_MAX_LENGTH` ограничивают размер пользовательского контекста перед отправкой в модель.
- Browser-сессия опирается на secure Better Auth cookies; клиент не хранит bearer token в `localStorage` и не использует его как источник истины для auth.
- AI endpoint работает только при наличии корректного Vertex AI конфига и credentials; без них backend отвечает явной конфигурационной ошибкой.
- При превышении rate limit сервер возвращает `429 RATE_LIMIT_EXCEEDED`, а при конкурирующих дорогих запросах вроде AI/sync может вернуть `503 ROUTE_BUSY`.
- После перехода со старого root API клиент и backend должны деплоиться вместе. Если браузер удерживает старый PWA shell, может понадобиться одноразовый refresh.
