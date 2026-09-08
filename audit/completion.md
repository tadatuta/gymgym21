# Итог аудита — 8 сентября 2026

Все 46 пунктов A01–A22, S01–S10, O01–O08, T01–T06 обработаны последовательно отдельными субагентами и отдельными коммитами в `refactor`. [Журнал](../AUDIT_PROGRESS.md) связывает каждый пункт с изменением, проверками и границами результата. Исходное тело [аудита](../PROJECT_AUDIT.md) сохранено как история; изменён только поясняющий banner.

T06 удаляет из HTTP tests реализацию memory repository, alias normalization и неверную копию public statistics. Вместо неё — явно заданные DTO и tracker аргументов; незаданный вызов бросает ошибку. Проверены реальные маршруты health/CORS/auth, rate limits, удалённые snapshot endpoints, 401, query validation, forwarding sync/context, AI deadline/disconnect и удержание concurrency при игнорируемом abort. Конфликты, tombstones и статистика проверяются настоящим PostgreSQL repository по [матрице T03](postgres-tests.md), без подмены SQL алгоритмами.

Общие [JSON examples](../test/fixtures/contracts.json) находятся вне production source/exports/dist. Клиент использует настоящие `parseSyncResponse` и contract schemas; сервер передаёт valid requests через HTTP, отклоняет invalid requests до repository и проверяет response contracts. Public DTO проходит серверный HTTP и клиентскую schema. NaN проверяется отдельно: JSON не представляет это значение.

Старые `reproduce.mjs` и `reproduce-server.mjs` теперь запускают соответственно `npm run check` и `npm run test:integration`, передают exit code и ничего не переписывают в compiled source. Отсутствие disposable PostgreSQL URL во втором wrapper проверено: ошибка до build/import. Они больше не утверждают наличие исправленных дефектов.

Повторено в T06 на Node 22.23.2:

- `npm run check` с disposable PostgreSQL: typecheck, ESLint и production build всех пакетов; contracts 9, client 220, server 108 passed; один отдельный TLS fixture test skipped.
- `node audit/reproduce-server.mjs`: 108 passed, 1 отдельный TLS skip; UUID-схемы создаются и удаляются тестами.
- `npm run test:browser`: 7/7 fixtures, pinned Chromium 151 без overrides; настоящие HTTP/PG/IndexedDB и SW install/activate/reload.

Накопленные отдельные проверки не выдаются за новый прогон T06: T05 подтвердил чистый offline npm ci, npm ls all и npm audit (0 уязвимостей); O06 — отдельный TLS fixture 3/3 и actual runtime CA mount; O04 — Docker Linux ARM64; O01 — большой synthetic performance fixture. Подробности и ограничения сохранены в [каталоге доказательств](README.md).

Границы: hosted GitHub Actions ещё не запускался, push не выполнялся; внешние AI/Telegram providers проверялись синтетически, физический passkey/OS install не подтверждены. Официальный Telegram SDK сохраняет обоснованное CSP `unsafe-eval`. Начальная загрузка клиентского кэша остаётся O(N); SQL агрегаты на cache miss читают историю. Docker проверен на Linux ARM64. Эти ограничения не обозначены как пройденные внешние проверки. Пользовательские ignored файлы, настоящие `.env`, секреты и рабочая БД не читались и не менялись.
