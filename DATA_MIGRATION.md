# План миграции хранения данных из файловой системы в PostgreSQL

## 1. Решения, которые зафиксированы

- Файловое хранилище полностью удаляется из приложения.
- Обратная совместимость с файловым storage не сохраняется.
- Автоматической миграции при старте сервера не будет.
- Переход делается через даунтайм: сервер можно полностью остановить на время миграции.
- Нужен отдельный ручной импорт-скрипт для переноса JSON-данных в PostgreSQL.
- После миграции PostgreSQL становится обязательным для backend-окружений.
- Перевод делаем сразу на целевую архитектуру, без hybrid-режима и dual-write.

## 2. Что важно сохранить из текущего поведения

Несмотря на полный отказ от файловой реализации, контракт API и поведение клиента лучше сохранить, чтобы миграция была backend-only по смыслу, а не переписыванием всего продукта.

Сохранить нужно:

- `GET /api/me/storage` возвращает полный snapshot в текущем JSON-формате.
- `PUT /api/me/storage` остаётся операцией полного перезаписывания snapshot пользователя.
- `POST /api/me/storage/sync` сохраняет текущий wire contract:
  - `baseRevision`
  - `changes`
  - `revision`
  - `conflicts`
  - `stale-version`
- Глобальный `revision` на пользователя.
- Персональный `version` для каждой сущности.
- `serverUpdatedAt` для сущностей, которые меняет сервер.
- Soft delete через `isDeleted`, а не физическое удаление из ответов API.
- Текущая логика публичного профиля:
  - приоритет идентификатора `username -> telegramUsername -> id_<storageKey>`
  - фильтрация deleted-данных
  - отдача полной истории только при `showFullHistory`.
- Текущее обогащение профиля auth-метаданными:
  - canonical username
  - telegram username / telegram user id
  - photo URL

## 3. Наблюдения по текущему проекту

### 3.1 Текущая архитектура

Сейчас auth и метаданные уже живут в PostgreSQL, а пользовательские данные тренажёрного журнала живут в файловом storage.

Основные узлы:

- `apps/server/src/storage.ts`:
  - типы storage
  - `StorageRepository`
  - `FileStorageRepository`
  - public-profile cache
- `apps/server/src/services/storage-data.ts`:
  - нормализация данных
  - расчёт `revision` / `version`
  - merge для sync
- `apps/server/src/http/routes/me.ts`:
  - `GET /storage`
  - `PUT /storage`
  - `POST /storage/sync`
  - AI endpoint
- `apps/server/src/auth.ts`:
  - связывание auth user со `storageKey`
  - синхронизация профиля с auth metadata
  - legacy-логика вокруг Telegram и старых storage key
- `apps/server/src/auth-meta.ts`:
  - auth schema
  - `user_storage_binding`
  - `user_alias`

### 3.2 Что в текущем коде можно смело удалить

После принятого решения на чистый cutover не нужны:

- `FileStorageRepository`
- весь код работы с `fs`
- `STORAGE_DIR`
- lazy migration из `<storageKey>.json` в структуру каталогов
- `username_index.json`
- `public-profile-cache.json`
- file-backed alias lookup
- все fallback-пути вида "если нет БД, читаем из файлов"
- логика, которая выбирает `storageKey` на основе существования старых JSON-файлов
- логика конфликтов при Telegram-link, основанная на сравнении legacy storage

### 3.3 Что показал осмотр локальных JSON

Локальные sample-данные подтвердили важные требования к импортёру:

- в JSON встречаются данные без `revision`
- в JSON встречаются сущности без `version`
- часть сущностей без `updatedAt`
- под `data/storage` может лежать посторонний JSON, который не является storage snapshot

Следствие:

- импортёр обязан строго валидировать shape входных файлов
- импортёр не должен импортировать "всё подряд"
- нормализация старых данных должна быть общей и детерминированной

## 4. Целевая архитектура

## 4.1 Общий принцип

Хранение пользовательских данных полностью переносится в PostgreSQL и становится единственной реализацией storage backend.

Рекомендуемая модель:

- сохранить `StorageRepository` как seam для тестируемости и изоляции transport-слоя
- удалить файловую реализацию
- добавить единственную реализацию `PostgresStorageRepository`
- перестать смешивать auth alias lookup и storage alias lookup

Идея "сразу хорошо" здесь означает не просто переписать `fs.readFile()` на SQL, а:

- убрать все legacy fallback paths
- убрать storage-логику из файловой системы полностью
- сделать storage lookup, public profile и cache транзакционными
- оставить snapshot-представление только как внешний API-контракт, а не как физическую модель хранения

## 4.2 Рекомендуемая схема таблиц

Ниже схема, которая закрывает текущий функционал без избыточной нормализации маленьких вложенных структур.

### Таблица `storage_root`

Назначение:

- корневая строка пользователя
- хранение глобального `revision`
- точка row-level locking для конкурентных операций

Поля:

```sql
storage_key TEXT PRIMARY KEY
revision BIGINT NOT NULL DEFAULT 0
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### Таблица `storage_profile`

Назначение:

- единственный profile на `storage_key`
- хранение profile-level `version`
- хранение friends как `JSONB`, так как это маленькая вложенная структура, не участвующая в серверных выборках

Поля:

```sql
storage_key TEXT PRIMARY KEY REFERENCES storage_root(storage_key) ON DELETE CASCADE
profile_id TEXT NOT NULL
is_public BOOLEAN NOT NULL
show_full_history BOOLEAN NOT NULL DEFAULT FALSE
display_name TEXT
username TEXT
telegram_username TEXT
telegram_user_id BIGINT
photo_url TEXT
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
gender TEXT
birth_date DATE
height DOUBLE PRECISION
weight DOUBLE PRECISION
additional_info TEXT
friends_json JSONB NOT NULL DEFAULT '[]'::jsonb
version BIGINT NOT NULL
server_updated_at TIMESTAMPTZ NOT NULL
```

Ограничения:

- `gender IN ('male', 'female', 'other')` через `CHECK`

### Таблица `storage_workout_types`

```sql
storage_key TEXT NOT NULL REFERENCES storage_root(storage_key) ON DELETE CASCADE
id TEXT NOT NULL
name TEXT NOT NULL
category TEXT
sort_order INTEGER
updated_at TIMESTAMPTZ NOT NULL
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
version BIGINT NOT NULL
server_updated_at TIMESTAMPTZ NOT NULL
PRIMARY KEY (storage_key, id)
```

Ограничения:

- `category IN ('strength', 'time')` через `CHECK`

### Таблица `storage_workouts`

`pauseIntervals` лучше хранить как `JSONB`, потому что:

- это внутренняя вложенная структура
- она не участвует в поисковых запросах
- из-за неё не стоит плодить отдельную таблицу на первом проходе

```sql
storage_key TEXT NOT NULL REFERENCES storage_root(storage_key) ON DELETE CASCADE
id TEXT NOT NULL
start_time TIMESTAMPTZ NOT NULL
end_time TIMESTAMPTZ
name TEXT
status TEXT NOT NULL
is_manual BOOLEAN NOT NULL
pause_intervals_json JSONB NOT NULL DEFAULT '[]'::jsonb
updated_at TIMESTAMPTZ NOT NULL
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
version BIGINT NOT NULL
server_updated_at TIMESTAMPTZ NOT NULL
PRIMARY KEY (storage_key, id)
```

### Таблица `storage_logs`

```sql
storage_key TEXT NOT NULL REFERENCES storage_root(storage_key) ON DELETE CASCADE
id TEXT NOT NULL
workout_type_id TEXT NOT NULL
workout_id TEXT
reps DOUBLE PRECISION
weight DOUBLE PRECISION
duration DOUBLE PRECISION
duration_seconds DOUBLE PRECISION
logged_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
version BIGINT NOT NULL
server_updated_at TIMESTAMPTZ NOT NULL
PRIMARY KEY (storage_key, id)
```

Примечание:

- поле `date` из API лучше хранить как `logged_at TIMESTAMPTZ`
- на границе репозитория сериализовать обратно в ISO string

### Таблица `storage_identifier_alias`

Назначение:

- новый единый источник истины для публичных идентификаторов storage
- замена `username_index.json`
- отвязка lookup публичных профилей от auth-таблиц

Это важно, потому что storage может существовать независимо от auth-flow, а ручной импорт может загрузить storage раньше, чем появится связанный пользователь.

```sql
alias_lower TEXT PRIMARY KEY
alias TEXT NOT NULL
storage_key TEXT NOT NULL REFERENCES storage_root(storage_key) ON DELETE CASCADE
type TEXT NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Поддерживаемые типы:

- `canonical_username`
- `telegram_username`
- `storage_id`

Правила:

- всегда держать alias `id_<storageKey>`
- если есть `profile.username`, держать `canonical_username`
- если есть `profile.telegramUsername`, держать `telegram_username`
- любые устаревшие alias, которых больше нет в актуальном profile, удалять в той же транзакции

### Таблица `storage_public_profile_cache`

Назначение:

- DB-backed replacement для `public-profile-cache.json`
- быстрый repeated-read без полного пересчёта

```sql
storage_key TEXT PRIMARY KEY REFERENCES storage_root(storage_key) ON DELETE CASCADE
source_revision BIGINT NOT NULL
payload JSONB NOT NULL
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

## 4.3 Индексы

Минимально необходимые индексы:

```sql
CREATE INDEX storage_workout_types_storage_version_idx
  ON storage_workout_types(storage_key, version DESC);

CREATE INDEX storage_logs_storage_version_idx
  ON storage_logs(storage_key, version DESC);

CREATE INDEX storage_workouts_storage_version_idx
  ON storage_workouts(storage_key, version DESC);

CREATE INDEX storage_logs_storage_workout_type_idx
  ON storage_logs(storage_key, workout_type_id);

CREATE INDEX storage_logs_storage_workout_idx
  ON storage_logs(storage_key, workout_id);

CREATE INDEX storage_profile_public_idx
  ON storage_profile(storage_key)
  WHERE is_public = TRUE AND is_deleted = FALSE;
```

## 5. Что нужно поменять в коде

## 5.1 Миграции БД

Сейчас auth schema создаётся большим SQL-блоком через `ensureAuthDatabaseSchema()`.

Для storage этого уже недостаточно. Нужен нормальный migration-подход:

- отдельная директория SQL-миграций для server БД
- bootstrap миграций до старта приложения
- возможность прогнать миграции отдельно перед деплоем

Рекомендация:

- не продолжать раздувать `AUTH_SCHEMA_SQL`
- вынести auth schema в миграции постепенно или, как минимум, новые storage-таблицы добавлять уже только через новый migration runner

## 5.2 Storage слой

Нужно:

- удалить файловые утилиты из `apps/server/src/storage.ts`
- вынести типы storage в отдельный модуль
- добавить `PostgresStorageRepository`
- оставить public interface репозитория, но сократить его до реально нужных операций

Рекомендуемое API репозитория:

- `readSnapshot(storageKey)`
- `replaceSnapshot(storageKey, data)`
- `sync(storageKey, request, authContext)`
- `getPublicProfileByStorageKey(storageKey, fallbackIdentifier?)`
- `findStorageKeyByPublicIdentifier(identifier)`

Нужно удалить как устаревшее:

- `ensureStorageDir`
- `updateUsernameIndex`
- `readUsernameIndex`
- file-backed `exists`
- все методы ленивой миграции файлов

Если проверка существования storage всё ещё нужна auth-flow, она должна идти через `storage_root`.

## 5.3 Нормализация и sync

`apps/server/src/services/storage-data.ts` уже содержит полезную бизнес-логику:

- нормализация старых сущностей
- присвоение `version`
- merge для sync
- конфликты `stale-version`

Её стоит сохранить, но сделать независимой от файлового backend.

Нужно:

- оставить текущие функции как domain-layer
- убрать оттуда любые скрытые допущения о file-backed snapshot
- добавить helper-слой сериализации:
  - `db row -> StorageData`
  - `StorageData -> db rows`

Первый проход миграции может оставаться snapshot-aware внутри `syncStorageData()`, но физическая запись в БД должна быть entity-level.

## 5.4 Auth слой

Так как backward compatibility отменена, auth можно заметно упростить.

Нужно удалить из `apps/server/src/auth.ts`:

- `chooseStorageKeyForUser()`
- `assertNoStorageConflictForTelegramLink()`
- все вызовы `Storage.exists()` для поиска legacy snapshot
- все ветки, которые выбирают `storageKey` по старым Telegram id из файлового storage

Новая модель:

- для нового пользователя storage создаётся детерминированно, например `u_<userId>`
- `user_storage_binding` остаётся как связь user -> storage_key
- `syncStorageProfile()` остаётся, но пишет в PostgreSQL storage
- legacy-merge логика между "текущим аккаунтом" и "старым Telegram JSON" удаляется

Важно:

- auth username availability по-прежнему остаётся задачей `user_alias`
- lookup публичного профиля больше не должен зависеть от `user_alias`
- публичные alias живут в `storage_identifier_alias`

## 5.5 Public profile

`apps/server/src/services/public-profile.ts` нужно упростить:

- всегда искать `storage_key` по `storage_identifier_alias`
- не делать fallback в файловый index
- не привязывать успех lookup к `HAS_DATABASE`

Итог:

- если backend без `DATABASE_URL`, он просто не должен стартовать
- `HAS_DATABASE` как режим совместимости для storage становится не нужен

## 5.6 Config, Docker, README

Нужно удалить:

- `STORAGE_DIR`
- `STORAGE_HOST_DIR`
- volume mount под `/data/storage`
- README-секции про file-backed storage
- `.env.example` и `apps/server/.env.example` переменные, относящиеся к файловому backend

После миграции backend должен зависеть только от PostgreSQL и внешних секретов AI.

## 6. Как должен работать `PostgresStorageRepository`

## 6.1 Общий принцип конкурентной записи

Для любой write-операции по пользователю:

1. открыть транзакцию
2. гарантировать наличие строки в `storage_root`
3. взять row lock через `SELECT ... FOR UPDATE`
4. прочитать актуальное состояние пользователя
5. применить domain-логику
6. записать новые rows
7. обновить `storage_root.revision`
8. обновить alias и cache
9. закоммитить

Это полностью заменяет текущий in-memory lock и решает межпроцессные гонки на уровне БД.

## 6.2 `readSnapshot`

Алгоритм:

1. загрузить `storage_root`
2. загрузить `storage_profile`
3. загрузить `storage_workout_types`
4. загрузить `storage_logs`
5. загрузить `storage_workouts`
6. собрать `StorageData`
7. сериализовать timestamps обратно в ISO strings

Возвращаемый shape должен совпадать с текущим API.

## 6.3 `replaceSnapshot`

Семантика должна остаться такой же, как сейчас:

- входной payload валидируется
- profile обогащается auth metadata
- версиям сущностей назначаются новые значения
- пользовательский snapshot считается authoritative

Алгоритм:

1. взять lock на `storage_root`
2. прочитать текущее состояние
3. прогнать через `prepareStorageDataForWrite()`
4. в транзакции:
   - upsert `storage_root`
   - заменить `storage_profile`
   - заменить набор `storage_workout_types`
   - заменить набор `storage_logs`
   - заменить набор `storage_workouts`
   - обновить `revision`
   - пересобрать alias
   - инвалидировать public profile cache

## 6.4 `sync`

На первом этапе реализация может использовать текущую domain-логику merge:

1. lock на `storage_root`
2. прочитать snapshot из БД
3. прогнать через `syncStorageData()`
4. записать обратно только изменившиеся сущности
5. вернуть текущий `StorageSyncResponse`

Это даст безопасный перенос без смены внешнего поведения.

Отдельный performance-рефакторинг на truly incremental sync можно делать позже, уже поверх Postgres.

## 6.5 Alias и cache внутри транзакции

При изменении profile необходимо в той же транзакции:

- пересчитать набор публичных alias
- удалить устаревшие alias
- upsert новых alias
- удалить или обновить cache публичного профиля

Важно делать это транзакционно, иначе можно получить:

- profile уже новый, а alias ещё старый
- alias уже новый, а cache ещё старый

## 7. Ручной импортёр JSON -> PostgreSQL

## 7.1 Где разместить

Рекомендуемое место:

- `apps/server/scripts/import-storage-json.mjs`

Почему не TypeScript:

- не нужен дополнительный runtime для TS-скриптов
- можно запускать обычным Node 22
- в проекте уже есть `pg`, этого достаточно

## 7.2 Интерфейс скрипта

Поддержать флаги:

- `--dir <path>`: директория с JSON-файлами
- `--manifest <path>`: optional mapping-файл для привязки imported storage к auth user
- `--dry-run`: только анализ, без записи
- `--apply`: фактический импорт
- `--skip-invalid`: пропускать невалидные файлы и продолжать
- `--truncate-storage`: очищать storage-таблицы перед импортом
- `--report <path>`: сохранить JSON-отчёт
- `--verbose`

Рекомендуемый запуск:

```bash
node apps/server/scripts/import-storage-json.mjs --dir ./data/storage --dry-run
node apps/server/scripts/import-storage-json.mjs --dir ./data/storage --manifest ./import-manifest.json --apply
```

## 7.3 Что должно быть в manifest

Manifest нужен не всегда, но он становится обязательным, если импортированные storage надо привязать к существующим auth user.

Пример:

```json
[
  {
    "sourceKey": "106835245",
    "storageKey": "106835245",
    "userId": "2b6f2d5e-0e8a-49a4-a2c0-6c0c587ac0b3"
  },
  {
    "sourceKey": "u_9d9e7040-0c5f-471d-beff-1ab8b65c2261",
    "storageKey": "u_9d9e7040-0c5f-471d-beff-1ab8b65c2261"
  }
]
```

Правила:

- если `storageKey` не указан, по умолчанию используется `sourceKey`
- если `userId` указан, скрипт делает upsert в `user_storage_binding`
- если `userId` не указан, storage импортируется как standalone-data и не будет доступен через `/api/me/*`, пока binding не появится

## 7.4 Алгоритм импортёра

Для каждого файла:

1. взять имя файла без `.json` как `sourceKey`
2. пропустить служебные файлы, которые не выглядят как storage snapshot
3. распарсить JSON
4. провалидировать top-level shape:
   - допустимы только `revision`, `profile`, `workoutTypes`, `logs`, `workouts`
5. прогнать данные через общую нормализацию
6. получить нормализованный `StorageData`
7. в транзакции:
   - upsert `storage_root`
   - записать profile / workoutTypes / logs / workouts
   - обновить alias
   - при желании сразу прогреть public profile cache
   - если есть `userId` в manifest, сделать upsert в `user_storage_binding`
8. записать результат в отчёт

## 7.5 Нормализация при импорте

Импорт должен использовать тот же общий helper, что и runtime storage.

Нельзя делать отдельную "почти такую же" реализацию, иначе будет рассинхрон.

Нормализация должна:

- гарантировать массивы для `workoutTypes`, `logs`, `workouts`
- гарантировать корректный profile shape
- дозаполнять `updatedAt`, если его нет
- назначать `serverUpdatedAt`
- назначать `version`
- вычислять итоговый `revision`

Рекомендация для импортёра:

- использовать один `importedAt` timestamp на весь файл
- для отсутствующего `updatedAt` брать:
  - существующий `createdAt` профиля
  - или `logged_at / start_time` когда это уместно
  - или `importedAt` как fallback

Такой подход делает импорт детерминированнее, чем вариант "каждой записи присвой текущее время в момент цикла".

## 7.6 Как импортёр должен реагировать на мусорные файлы

Если файл:

- невалидный JSON
- содержит неожиданный top-level shape
- не содержит ни одной storage-секции

то он:

- не импортируется
- попадает в отчёт как `skipped`
- при `--skip-invalid=false` останавливает процесс

Это обязательно, потому что в `data/storage` могут лежать посторонние JSON-файлы.

## 7.7 Что должно попасть в отчёт импортёра

Отчёт должен содержать:

- сколько файлов найдено
- сколько storage-файлов импортировано
- сколько пропущено
- сколько файлов не прошло валидацию
- список `sourceKey -> storageKey`
- число импортированных `workoutTypes`
- число импортированных `logs`
- число импортированных `workouts`
- сколько storage привязано к `userId`
- список ошибок по файлам

## 8. Поэтапный план реализации

## Этап 1. Подготовить новую storage-модель

Задачи:

- согласовать итоговую схему таблиц
- решить naming для новых модулей storage
- описать DB migration strategy

Результат:

- есть финальный DDL
- понятно, какие legacy-модули будут удалены

## Этап 2. Добавить SQL-миграции

Задачи:

- добавить migration runner
- создать миграцию для:
  - `storage_root`
  - `storage_profile`
  - `storage_workout_types`
  - `storage_workouts`
  - `storage_logs`
  - `storage_identifier_alias`
  - `storage_public_profile_cache`
  - индексов и ограничений

Результат:

- чистая БД поднимается сразу с новой storage-схемой

## Этап 3. Реализовать `PostgresStorageRepository`

Задачи:

- написать SQL read/write paths
- вынести row mappers
- обеспечить lock через `SELECT ... FOR UPDATE`
- собрать `StorageData` из таблиц
- сохранить текущий JSON contract API

Результат:

- storage может полностью жить в PostgreSQL

## Этап 4. Перевести server routes и сервисы на новый backend

Задачи:

- подключить `PostgresStorageRepository`
- удалить file-backed реализацию
- удалить file-based public profile lookup
- перевести public profile на alias table
- адаптировать `syncStorageProfile()`

Результат:

- маршруты `/api/me/storage`, `/api/me/storage/sync`, `/api/profiles/:identifier`, AI endpoint работают только через БД

## Этап 5. Упростить auth и удалить legacy-ветки

Задачи:

- удалить legacy file storage checks
- удалить выбор `storageKey` по старым Telegram JSON
- оставить deterministic binding для новых user
- сохранить `user_storage_binding`

Результат:

- auth-код больше не зависит от старого файлового мира

## Этап 6. Написать импортёр

Задачи:

- реализовать CLI-скрипт
- добавить dry-run
- добавить manifest support
- добавить отчёт
- покрыть тестами сложные shape cases

Результат:

- данные можно вручную и воспроизводимо перелить в БД

## Этап 7. Обновить конфиг, Docker и документацию

Задачи:

- удалить `STORAGE_DIR` и связанные env
- убрать volume mount storage из `docker-compose.yml`
- обновить `.env.example`
- обновить `apps/server/.env.example`
- переписать README

Результат:

- развертывание соответствует новой архитектуре

## Этап 8. Прогнать тесты и cutover rehearsal

Задачи:

- прогнать unit/integration tests
- прогнать dry-run importer на реальных данных
- проверить отчёт
- проверить smoke-сценарии на тестовой БД

Результат:

- понятен реальный cutover plan без сюрпризов

## 9. Тестовая стратегия

## 9.1 Контрактные тесты репозитория

Нужно сделать единый набор тестов для storage contract:

- чтение пустого snapshot
- `PUT /storage` как полный replace
- `POST /storage/sync` с новой сущностью
- conflict `stale-version`
- soft delete
- конкурентные sync-запросы
- public profile build
- public profile cache invalidation

Лучше всего:

- поднять temp Postgres schema
- гонять repository integration tests против реальной БД

## 9.2 Интеграционные HTTP-тесты

Нужно оставить и адаптировать сценарии:

- `GET /api/me/storage`
- `PUT /api/me/storage`
- `POST /api/me/storage/sync`
- `POST /api/me/ai/recommendations`
- `GET /api/profiles/:identifier`
- better-auth profile enrichment

Нужно удалить и заменить:

- тесты на lazy file migration
- тесты на file-backed cache файлы
- тесты на file-backed username index

## 9.3 Тесты импортёра

Обязательно покрыть:

- валидный legacy JSON без `revision`
- JSON без `version`
- JSON без части `updatedAt`
- пустые массивы
- файл без profile
- файл с deleted-сущностями
- посторонний JSON в директории
- manifest binding to `user_storage_binding`
- dry-run без записи

## 9.4 Concurrency-тесты

Обязательно проверить на реальной PostgreSQL:

- два sync одновременно на один `storageKey`
- sync и full replace одновременно
- одновременное обновление profile и alias/cache

## 10. План cutover под даунтайм

Так как даунтайм допустим, лучший сценарий простой и безопасный.

### Шаг 1. Подготовка

- остановить backend
- снять backup PostgreSQL
- сохранить копию каталога с JSON-файлами
- убедиться, что импорт будет идти в правильную БД

### Шаг 2. Применить миграции БД

- прогнать storage SQL migrations
- убедиться, что новые таблицы созданы

### Шаг 3. Прогнать dry-run импорт

- запустить импортёр в `--dry-run`
- посмотреть отчёт
- отдельно проверить пропущенные / мусорные файлы
- при необходимости скорректировать manifest

### Шаг 4. Выполнить импорт

- при необходимости очистить новые storage-таблицы
- запустить `--apply`
- сохранить итоговый report

### Шаг 5. Поднять новую версию backend

- задеплоить backend без файлового storage
- убедиться, что сервер стартует только с БД

### Шаг 6. Smoke-проверка

Проверить вручную:

- `GET /health`
- регистрация нового пользователя
- вход существующего пользователя
- чтение `/api/me/storage`
- запись `/api/me/storage`
- `POST /api/me/storage/sync`
- `GET /api/profiles/:identifier`
- `POST /api/me/ai/recommendations`

### Шаг 7. После запуска

- old JSON оставить только как архив и backup
- больше не монтировать их в runtime
- не использовать старый storage-код ни в каком режиме

## 11. План rollback

Так как обратная совместимость не нужна, rollback должен быть операционным, а не внутри кода.

Если cutover не удался:

1. остановить новую версию backend
2. восстановить backup PostgreSQL или очистить новые storage-таблицы
3. вернуть предыдущую версию backend
4. вернуть старый deployment/runtime с файловым storage
5. поднять сервер на старой архитектуре

Именно поэтому перед cutover нужно:

- сохранить backup БД
- сохранить полный backup `data/storage`
- не удалять исходные JSON до успешной проверки продовой версии

## 12. Что считаем готовым результатом

Миграция считается завершённой, когда:

- в коде нет файлового storage backend
- backend не использует `STORAGE_DIR`
- storage данные целиком хранятся в PostgreSQL
- public profile lookup идёт через DB alias table
- импорт JSON возможен отдельным ручным скриптом
- auth-код больше не содержит legacy file-based веток
- integration tests проходят на PostgreSQL
- README и deploy-конфиг соответствуют новой архитектуре

## 13. Практические рекомендации по реализации

- Не пытаться одновременно "идеально оптимизировать sync". Сначала перенести storage в PostgreSQL без смены семантики.
- Не тащить новые библиотеки без необходимости. Для storage и импортёра достаточно `pg` и текущих server-side модулей.
- Нормализацию import/runtime нужно сделать общей, иначе потом начнутся отличия между "импортированным" и "созданным через API" storage.
- Public profile aliases лучше хранить отдельно от `user_alias`, потому что это другой bounded context.
- Конкурентную запись решать только транзакциями PostgreSQL, без process-local locking.

## 14. Рекомендуемый порядок PR-ов

Если разбивать работу на внятные куски, то лучший порядок такой:

1. PR 1: migration runner + SQL schema для storage
2. PR 2: `PostgresStorageRepository` + repository tests
3. PR 3: перевод HTTP routes и public profile на новый backend
4. PR 4: зачистка auth legacy-веток и удаление file storage кода
5. PR 5: import CLI + fixtures + importer tests
6. PR 6: cleanup config / docker / README

Такой порядок даёт:

- понятный review scope
- меньше риска потерять семантику sync
- возможность отдельно прогнать dry-run importer до cutover

## 15. Отдельное решение, которое нужно учесть при импорте

Ручной импорт данных и привязка их к auth user - это не одно и то же.

Нужно заранее подготовить mapping, если вы хотите, чтобы импортированные storage сразу открывались конкретным пользователям через `/api/me/*`.

Правило:

- без `user_storage_binding` storage импортируется в БД, но не становится "данными текущего пользователя" автоматически
- если нужен немедленный доступ пользователя к данным, binding должен быть создан импортёром через manifest

Это не мешает реализации миграции, но это обязательная часть операционного запуска импортёра.
