# PostgreSQL repository: покрытие T03

Проверено 8 сентября 2026 на Node 22.23.2 и отдельной PostgreSQL 16. Тесты импортируют production repository из `apps/server/dist`, выполняют реальные SQL и миграции в UUID-схемах, закрывают pool и удаляют схемы в `finally`. Пользовательская БД и `.env` не используются. Существующие регрессии A/S/O сохранены; T03 добавляет один недостающий сценарий изоляции при совпадающих IDs.

| Требование исходного T03 | Исполняемое доказательство |
| --- | --- |
| Пустой pull после записи второго устройства | [sync-receipts.test.js](../apps/server/test/sync-receipts.test.js): `two clients: repeated empty batch…` — тот же batchId/cursor видит новые записи; legacy empty receipt не замораживает ответ. |
| Потеря ответа и retry | [sync-receipts.test.js](../apps/server/test/sync-receipts.test.js): `lost push response…`, `conflict retry…`, `concurrent retries…` — прежний ack, актуальные submitted entities/serverVersion, отсутствие повторного применения; legacy full receipt и advanced cursor. Потеря ответа моделируется повторным вызовом repository после завершённого commit. |
| Версии, deletion и атомарность | [sync-receipts.test.js](../apps/server/test/sync-receipts.test.js): `mixed entities…`, `late SQL failure…`, `push plus paged pull…` — monotonic revisions, нормализация, tombstones, конфликты, pagination; ошибка SQL на записи receipt откатывает все восемь таблиц. [backup.test.js](../apps/server/test/backup.test.js): merge/replace, empty replace всех сущностей, concurrent revision guard, malformed input без изменений. |
| Aliases и ownership | [public-aliases.test.js](../apps/server/test/public-aliases.test.js): authoritative binding, canonical/Telegram/storage aliases, приватность и collisions. [identity.test.js](../apps/server/test/identity.test.js): настоящий HTTP cookie resolver, запрет чужого account/payload и concurrent auth/public claims в общей namespace. |
| Cache invalidation | [public-stats.test.js](../apps/server/test/public-stats.test.js): cache hit, запись/смена зоны, rollout миграций 003/004. [bounded-reads.test.js](../apps/server/test/bounded-reads.test.js): revision-bound keyset cursor, privacy, согласованный read snapshot и запрет замены нового кэша старым чтением. |
| Миграции | [migrations.test.js](../apps/server/test/migrations.test.js): три отдельных процесса на пустой схеме, все семь миграций ровно один раз; frozen legacy auth DDL/данные, ограничения uniqueness/FK; SQL failure внутри 006 откатывает файл, освобождает lock и допускает retry; общий pool/auth handler восстанавливаются после закрытия. |
| Изоляция одинаковых IDs — добавлено в T03 | [sync-receipts.test.js](../apps/server/test/sync-receipts.test.js): `identical entity and batch IDs…` — два storage keys используют одинаковые IDs всех четырёх сущностей и batchId, но разные payload/revision histories. Удаление A оставляет snapshot, aliases и SQL-строку кэша B неизменными; кэш A инвалидируется, публичный A скрывается. Retry A возвращает его tombstones, retry B — исходный B, пустой pull B не получает изменений A. |

Запуск из корня после установки зависимостей:

```sh
GYM21_TEST_DATABASE_URL=<disposable-postgres-url> npm run test:integration
```

Команда сама собирает contracts/server; отсутствие тестового PostgreSQL URL — ошибка. Для адресного прогона после сборки: `GYM21_TEST_DATABASE_URL=<disposable-postgres-url> node --test apps/server/test/sync-receipts.test.js`.

Результат T03: адресный файл — 10 passed, 0 skipped; полный `test:integration` — 95 passed, 1 skipped (отдельная TLS fixture, [условия](postgres-tls.md)). Runtime и зависимости не изменены. Это локальное подтверждение, удалённый GitHub Actions run не выполнялся. Расширение auth endpoint сценариев — T04; реальные browser/offline сценарии — T05; общие contract fixtures и исторические reproduce-скрипты — T06.
