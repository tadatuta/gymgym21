# Gym21

Дневник тренировок: Telegram Mini App и самостоятельное PWA с локальной IndexedDB и синхронизацией через PostgreSQL.

- `apps/client` — TypeScript, Vite/PWA, DOM/CSS и Dexie.
- `apps/server` — Express, Better Auth, PostgreSQL и AI API.
- `packages/contracts` — общие runtime-схемы и типы протокола.
- `infra/nginx` — reverse proxy для single-origin Docker.

## Быстрый запуск

Из корня репозитория, Node.js 22.23.2 (`.nvmrc`), npm 10+:

```bash
nvm install
nvm use
npm ci
```

Создайте корневой `.env` по `.env.example`, задайте `DATABASE_URL` и `BETTER_AUTH_SECRET`, запустите PostgreSQL, затем:

```bash
npm run dev
```

Клиент: `http://localhost:5173`, API: `http://localhost:8788`. Dev-сервер читает корневой `.env`; экспортированное окружение имеет приоритет. Production `start` сам `.env` не читает.

## Документация

- [Архитектура и инварианты](docs/architecture.md).
- [Runbook: разработка, проверки, Docker, миграции, импорт, лимиты и восстановление](docs/runbook.md).
- [Клиент и Telegram](apps/client/README.md), [ручные сценарии](apps/client/test-cases.md).
- [Текущий прогресс исправлений](AUDIT_PROGRESS.md), [исторический аудит](PROJECT_AUDIT.md), [каталог доказательств и проверок](audit/README.md).
- [Миграция данных](DATA_MIGRATION.md), [архив исходного плана](docs/archive/DATA_MIGRATION.md).

`npm run check` запускает typecheck, lint, тесты и сборку всех трёх пакетов с остановкой при ошибке. `npm test` запускает тесты контрактов, клиента и сервера. Обязательный PostgreSQL-прогон: `GYM21_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:integration`; условия и отдельная TLS-проверка перечислены в runbook. [GitHub Actions CI](.github/workflows/ci.yml) выполняет чистую установку, общие проверки и обязательную интеграцию с отдельной PostgreSQL 16 на Node 22 при push и pull request. T03–T06 остаются следующими пунктами аудита.
