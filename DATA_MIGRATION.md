# Миграция хранения данных в PostgreSQL: финальный архитектурный план

## 1. Контекст и принятые допущения

Этот документ фиксирует целевой план миграции проекта с файлового хранения на PostgreSQL с правом полного переписывания технической архитектуры.

Зафиксированные вводные:

- можно полностью переписывать внутреннюю архитектуру проекта;
- обратная совместимость с файловым storage не нужна;
- runtime-поддержка JSON-файлов не нужна;
- автоматическая миграция при старте приложения не нужна;
- допустим даунтайм на время cutover;
- нужен отдельный ручной импортёр данных из JSON в PostgreSQL;
- главное требование: сохранить пользовательские сценарии и offline-first;
- все технические решения можно менять в пользу масштабируемости, надёжности и удобства разработки.

Ключевая мысль: после этой миграции мы не переносим старый storage "как есть" в SQL. Мы меняем архитектуру проекта так, чтобы она изначально была рассчитана на нормальную работу с PostgreSQL и локальным offline-first клиентом.

## 2. Что действительно нужно сохранить

Сохранять нужно не старые endpoint'ы и не старые внутренние интерфейсы, а пользовательские возможности.

### 2.1 Пользовательские сценарии

После миграции пользователь должен по-прежнему уметь:

- открывать приложение и сразу видеть локальные данные без ожидания сети;
- создавать тренировку, подходы, типы упражнений и менять профиль без подключения к интернету;
- продолжать работать офлайн сколько угодно долго;
- после появления сети синхронизировать локальные изменения с сервером;
- входить на новом устройстве и получать актуальные данные;
- публиковать профиль и открывать его по публичной ссылке;
- связывать аккаунт с Telegram и не терять связанные данные;
- получать AI-рекомендации на основе актуальных тренировочных данных;
- не терять пользовательские данные из-за конкурентных запросов или рестартов сервера.

### 2.2 Offline-first инварианты

После миграции система должна явно сохранять следующие свойства:

- UI читает данные из локальной базы, а не зависит от онлайн-запросов как от источника истины;
- сеть нужна для синхронизации, а не для базовых CRUD-операций;
- локальные изменения сначала попадают в local database / outbox, а потом уходят на сервер;
- отсутствие сети не блокирует работу с основными сущностями;
- синхронизация не должна требовать чтения или записи полного snapshot пользователя;
- bootstrap нового клиента должен быть возможен без отдельного file-backed механизма.

### 2.3 Семантические инварианты sync

Даже если мы меняем transport и внутреннюю структуру, полезно сохранить или улучшить текущие смысловые гарантии:

- у пользователя есть глобальная монотонно растущая серверная позиция sync;
- у каждой сущности есть серверная версия;
- поддерживаются soft delete, а не только физическое удаление;
- конфликт stale update определяется на уровне версии сущности;
- сервер может вернуть authoritative version при конфликте;
- клиент может получить все изменения после своей последней sync-позиции.

### 2.4 Чего сохранять не нужно

Следующие вещи не являются целями миграции:

- сохранение `GET /api/me/storage` как runtime endpoint;
- сохранение `PUT /api/me/storage` как runtime endpoint;
- сохранение `StorageData` как главной доменной модели backend;
- сохранение snapshot-first repository API;
- сохранение файловой структуры `<storageKey>.json` или `<storageKey>/meta.json`;
- сохранение `STORAGE_DIR`, `username_index.json`, `public-profile-cache.json`;
- сохранение fallback-режима "если нет БД, читаем из файлов";
- сохранение текущего разделения кода на те же модули и те же интерфейсы;
- сохранение нынешних internal DTO, если они мешают архитектуре.

Иными словами, мы сохраняем продукт и UX, но не сохраняем старую технику.

## 3. Главные проблемы текущей архитектуры

Текущая реализация страдает сразу от нескольких системных ограничений.

### 3.1 Snapshot-first модель

Сейчас storage логически мыслится как один большой пользовательский snapshot:

- чтение часто означает "собери всё состояние пользователя";
- запись часто означает "прочитай всё, смержи всё, перезапиши всё";
- даже delta sync на практике тянет полное состояние пользователя в память.

Это плохо для:

- производительности;
- конкуренции;
- масштабирования;
- тестируемости;
- понятности кода.

### 3.2 Смешение продуктовой логики и storage-реализации

В текущем коде тесно переплетены:

- доменные сущности;
- файловое хранение;
- lazy migration;
- auth-flow;
- lookup публичного профиля;
- кэш публичного профиля.

Из-за этого любое изменение storage тянет за собой полпроекта.

### 3.3 Файловый backend определяет shape всей системы

Сейчас многие решения существуют потому, что так было удобно для файлов:

- snapshot DTO как универсальный формат;
- file-based alias/index;
- full-read/full-write поведение;
- special cases в auth для legacy storage key;
- отдельные compatibility-механизмы под старую структуру файлов.

После отказа от file-backed runtime эти ограничения нужно не "перенести", а удалить.

### 3.4 Конкуренция и надёжность

Файловая история привела к тому, что:

- были нужны process-local locks;
- storage safety зависела от конкретной реализации backend;
- некоторые гонки приходилось обходить организационно, а не архитектурно.

В PostgreSQL это должно замениться транзакциями и row-level locking.

## 4. Целевая архитектурная идея

Новая система должна состоять из двух полноценных частей:

- offline-first клиент, где локальная IndexedDB является источником истины для UI;
- сервер на PostgreSQL, который хранит нормализованные сущности и обслуживает только delta-oriented sync.

### 4.1 Что станет главным runtime-контрактом

Главный runtime use case после миграции:

- клиент отправляет локальные изменения;
- сервер атомарно применяет их;
- сервер возвращает все изменения после клиентской позиции sync;
- клиент обновляет локальную БД;
- UI продолжает работать только с локальной БД.

То есть центральной точкой системы становится не "прочитать/перезаписать snapshot", а "синхронизировать локальное состояние с сервером по дельтам".

### 4.2 Роль snapshot после миграции

Snapshot JSON остаётся только в двух ролях:

- ручной импорт legacy-данных;
- optional backup/export format.

В runtime он больше не является:

- внутренней доменной моделью backend;
- основным API-контрактом;
- основной единицей чтения/записи.

## 5. Целевая архитектура проекта

## 5.1 Клиент

Клиент остаётся offline-first, но внутренне становится более явно разделённым на слои.

Рекомендуемая структура клиента:

- `local database`:
  - таблицы сущностей;
  - sync metadata;
  - dirty/outbox state;
  - optional conflict state;
- `domain services`:
  - операции с тренировками, логами, профилем, друзьями;
- `sync worker`:
  - собирает локальные dirty-сущности;
  - отправляет их на сервер;
  - применяет ответ сервера;
- `UI`:
  - читает данные только из локальной БД.

### 5.1.1 Источник истины на клиенте

Источник истины для интерфейса:

- не HTTP-ответ;
- не server snapshot;
- не in-memory cache;
- а локальная IndexedDB.

Это ключевой принцип offline-first, и его нужно сохранить.

### 5.1.2 Dirty state / outbox

Текущий подход с `dirtyEntities` можно сохранить концептуально, но реализацию можно улучшить.

Целевой вариант:

- клиент не логирует каждую микроскопическую операцию как event sourcing;
- клиент хранит deduplicated outbox на уровне сущностей;
- если сущность изменялась 10 раз офлайн, на sync уходит её последнее локальное состояние плюс версия, на которой оно основано.

Это проще:

- для разработки;
- для отладки;
- для восстановления после ошибок;
- для поддержки клиента.

## 5.2 Сервер

Сервер после миграции должен быть разделён на несколько явных подсистем.

Рекомендуемые подсистемы:

- `Sync API`
- `Sync Service`
- `Entity Repositories`
- `Public Profile Read Model`
- `AI Context Queries`
- `Auth Integration`
- `Import CLI`

### 5.2.1 Что не должно остаться на сервере

После миграции на сервере не должно остаться:

- файлового storage backend;
- lazy migration файлов при чтении;
- режима без БД;
- file-based индексов alias;
- file-based public profile cache;
- логики выбора `storageKey` через существование JSON-файлов;
- legacy storage checks в auth-flow.

## 5.3 База данных

PostgreSQL становится единственным runtime-хранилищем пользовательских данных.

При этом база должна хранить:

- текущее состояние сущностей;
- серверную sync-позицию пользователя;
- серверные версии сущностей;
- alias публичных профилей;
- read model / cache для публичного профиля.

Важно: для текущего продукта не нужен полноценный runtime event log. Для sync нам достаточно current-state tables плюс глобальная ревизия.

## 6. Рекомендуемая серверная модель данных

Ниже описана рекомендуемая схема, ориентированная на:

- delta sync;
- offline-first bootstrap;
- простую разработку;
- понятные SQL-запросы;
- отказ от snapshot-first runtime.

## 6.1 Почему не нужен отдельный runtime event log

Мы не обязаны хранить все промежуточные изменения как append-only журнал, чтобы делать sync эффективно.

Достаточно следующей модели:

- у каждого пользователя есть глобальная серверная ревизия;
- каждая принятая сервером сущность получает новую версию;
- версия сущности равна одной из серверных ревизий пользователя;
- чтобы отдать изменения после позиции клиента, достаточно выбрать сущности с `version > cursor`.

Это означает:

- не нужно хранить полную историю всех серверных мутаций;
- не нужно гонять event sourcing только ради sync;
- bootstrap нового клиента делается запросом "дай всё, что изменилось после 0".

Если позже понадобится аудит, его можно добавить отдельной подсистемой, не делая его блокером миграции.

## 6.2 Базовые таблицы

### Таблица `storage_roots`

Назначение:

- одна строка на пользовательское пространство данных;
- хранение глобальной server revision;
- точка блокировки для конкурентного sync.

Поля:

```sql
storage_key TEXT PRIMARY KEY
server_revision BIGINT NOT NULL DEFAULT 0
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### Таблица `storage_profiles`

Поля:

```sql
storage_key TEXT PRIMARY KEY REFERENCES storage_roots(storage_key) ON DELETE CASCADE
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

Пояснения:

- `friends_json` можно оставить как `JSONB`, потому что это небольшая вложенная структура и она не требует сложных серверных запросов;
- если позже друзья станут отдельной важной доменной сущностью, их можно нормализовать отдельной миграцией.

### Таблица `storage_workout_types`

Поля:

```sql
storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE
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

### Таблица `storage_workouts`

Поля:

```sql
storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE
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

Поля:

```sql
storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE
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

## 6.3 Таблицы публичного профиля

### Таблица `public_profile_aliases`

Назначение:

- единый источник истины для публичных идентификаторов;
- отвязка profile lookup от auth-таблиц;
- отказ от `username_index.json`.

Поля:

```sql
alias_lower TEXT PRIMARY KEY
alias TEXT NOT NULL
storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE
type TEXT NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Поддерживаемые типы:

- `canonical_username`
- `telegram_username`
- `storage_id`

Правила:

- всегда существует alias `id_<storageKey>`;
- если у профиля есть `username`, он индексируется;
- если у профиля есть `telegramUsername`, он индексируется;
- старые alias, которых больше нет в актуальном профиле, удаляются в той же транзакции.

### Таблица `public_profile_cache`

Назначение:

- DB-backed кэш публичного профиля;
- быстрый repeated-read без чтения всех таблиц на каждый запрос.

Поля:

```sql
storage_key TEXT PRIMARY KEY REFERENCES storage_roots(storage_key) ON DELETE CASCADE
source_revision BIGINT NOT NULL
payload JSONB NOT NULL
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Принцип:

- при изменении `profile`, `logs`, `workoutTypes` кэш инвалидируется;
- при следующем чтении профиль собирается заново и кладётся в cache table.

## 6.4 Индексы

Минимальный набор:

```sql
CREATE INDEX storage_profiles_version_idx
  ON storage_profiles(storage_key, version DESC);

CREATE INDEX storage_workout_types_version_idx
  ON storage_workout_types(storage_key, version DESC);

CREATE INDEX storage_workouts_version_idx
  ON storage_workouts(storage_key, version DESC);

CREATE INDEX storage_logs_version_idx
  ON storage_logs(storage_key, version DESC);

CREATE INDEX storage_logs_workout_type_idx
  ON storage_logs(storage_key, workout_type_id);

CREATE INDEX storage_logs_workout_idx
  ON storage_logs(storage_key, workout_id);

CREATE INDEX public_profile_aliases_storage_idx
  ON public_profile_aliases(storage_key);
```

## 7. Новый runtime sync-контракт

## 7.1 Главный принцип

После миграции runtime API не должен опираться на отдельные snapshot endpoints.

Главный runtime endpoint:

- один sync endpoint для push + pull.

Путь можно оставить старый (`POST /api/me/storage/sync`) или упростить до нового (`POST /api/me/sync`). Для продукта это несущественно. Важна семантика.

## 7.2 Рекомендуемый sync request

На wire уровне можно использовать либо старые имена (`baseRevision/revision`), либо новые (`cursor/nextCursor`).

В этом документе для ясности используется термин `cursor`.

Рекомендуемый shape:

```json
{
  "cursor": 128,
  "changes": {
    "workoutTypes": [],
    "logs": [],
    "workouts": [],
    "profile": null
  }
}
```

Каждая отправляемая сущность должна содержать:

- `id`
- `updatedAt`
- `version` как последнюю известную серверную версию
- `isDeleted`, если это soft delete

## 7.3 Рекомендуемый sync response

```json
{
  "cursor": 136,
  "changes": {
    "workoutTypes": [],
    "logs": [],
    "workouts": [],
    "profile": null
  },
  "conflicts": []
}
```

Где:

- `cursor` — новая серверная позиция клиента;
- `changes` — все актуальные сущности, у которых `version > старый cursor`;
- `conflicts` — конфликты stale update.

## 7.4 Как делается bootstrap нового клиента

Новый клиент не требует отдельного snapshot API.

Он просто делает sync с:

```json
{
  "cursor": 0,
  "changes": {}
}
```

Сервер отвечает:

- всеми сущностями пользователя;
- их версиями;
- текущим `cursor`.

То есть bootstrap — это просто обычный delta sync с нулевой позицией.

## 7.5 Алгоритм серверного sync

Для одного `storageKey`:

1. начать транзакцию;
2. гарантировать наличие строки в `storage_roots`;
3. взять `SELECT ... FOR UPDATE` на `storage_roots`;
4. прочитать только те сущности, которые пришли во входящей дельте;
5. проверить конфликты по `version`;
6. для каждой принятой сущности:
   - увеличить `server_revision`;
   - записать эту ревизию как `version`;
   - обновить `server_updated_at`;
   - upsert или soft delete запись;
7. отдельно обработать profile и auth enrichment;
8. пересчитать alias публичного профиля;
9. инвалидировать public profile cache при необходимости;
10. выбрать все сущности с `version > cursor`;
11. вернуть response;
12. закоммитить транзакцию.

Ключевой момент:

- чтение идёт только по нужным id для merge;
- отдача изменений идёт через SQL `WHERE version > cursor`;
- чтения всего snapshot нет.

## 7.6 Конфликты и надёжность

Требование надёжности выше, чем в текущем коде.

Минимум, который должен быть обеспечен:

- сервер явно возвращает conflict по stale version;
- клиент не должен молча терять локальный intent без возможности отладки;
- конфликтующие сущности должны быть видны хотя бы в логах и локальном conflict state.

Рекомендуемый клиентский подход:

- authoritative server entity применяется в local DB;
- локальный конфликтующий вариант сохраняется в отдельной локальной conflict-таблице или помечается как требующий ручной/автоматической резолюции;
- dirty state не должен исчезать бесследно.

Это не обязательно означает большой продуктовый UI на первом этапе, но silent loss локальных изменений быть не должно.

## 8. Новая серверная декомпозиция

Полный redesign даёт шанс убрать "god storage module".

Рекомендуемая структура backend:

- `sync/types.ts`
  - wire DTO
  - entity types
- `sync/service.ts`
  - merge
  - conflict logic
  - cursor semantics
- `sync/repository.ts`
  - низкоуровневые SQL-операции
- `public-profile/service.ts`
  - alias lookup
  - cache/projection
- `ai/context.ts`
  - SQL query helpers для AI endpoint
- `auth/storage-binding.ts`
  - связь auth user <-> storage key
- `import-storage-json.mjs`
  - ручной importer

### 8.1 Что должно исчезнуть из core domain

После миграции `StorageData` больше не должен быть ядром серверной архитектуры.

Он может существовать как:

- DTO импортёра;
- debug/export shape;
- optional test helper.

Но не как обязательная форма runtime хранения.

### 8.2 Новые use-case oriented interfaces

Вместо одного `StorageRepository` лучше иметь несколько явных интерфейсов.

Например:

- `SyncRepository`
- `PublicProfileRepository`
- `AiContextRepository`
- `StorageBindingRepository`

Это упростит:

- тестирование;
- чтение кода;
- замену отдельных частей;
- внедрение новых read models.

## 9. Public profile и AI после redesign

## 9.1 Публичный профиль

Публичный профиль после миграции должен быть не "побочным эффектом storage", а отдельным read model.

Правильный путь:

- lookup по `public_profile_aliases`;
- проверка актуальности `public_profile_cache` по `source_revision`;
- если cache устарел, пересобрать его из сущностей пользователя;
- вернуть готовый payload.

Это существенно проще и надёжнее, чем хранить public profile в файловом кэше.

## 9.2 AI endpoint

AI endpoint после redesign не должен читать полный snapshot пользователя.

Вместо этого сервер должен извлекать только нужный набор данных:

- профиль;
- последние логи;
- список workout types;
- при необходимости последние/активные workout sessions.

Ограничения вроде:

- `AI_MAX_RECENT_LOGS`
- `AI_MAX_CONTEXT_CHARS`
- `AI_MAX_EXERCISE_COUNT`

должны применяться на уровне запросов и подготовки AI context, а не после загрузки полного user snapshot.

## 10. Auth после redesign

Так как legacy file storage полностью уходит, auth можно значительно упростить.

### 10.1 Что сохраняется

Сохраняется:

- `user_storage_binding`;
- auth-driven enrichment профиля;
- alias в auth-контексте для username availability и identity.

### 10.2 Что удаляется

Удаляется:

- поиск старого storage по JSON-файлам;
- выбор `storageKey` через существование legacy snapshot;
- merge логика между "новым user" и "старым Telegram JSON";
- проверки конфликтов на основании file-backed storage;
- fallback в режим без БД.

### 10.3 Новое правило создания storage

Новый storage создаётся детерминированно:

- например, `u_<userId>`.

Telegram link/sign-in после redesign:

- работают только с PostgreSQL;
- используют binding и alias таблицы;
- не ищут данные в legacy файлах.

## 11. Импорт legacy JSON в новую систему

## 11.1 Статус импортёра

Импортёр не часть runtime.

Это отдельный ручной инструмент, который:

- читает legacy JSON;
- валидирует их;
- нормализует данные;
- записывает их в новые PostgreSQL таблицы.

## 11.2 Где разместить

Рекомендуемое место:

- `apps/server/scripts/import-storage-json.mjs`

Почему отдельный Node-скрипт:

- не нужен дополнительный TS-runtime;
- можно запускать вручную и воспроизводимо;
- легко использовать в dry-run и cutover.

## 11.3 Интерфейс импортёра

Поддержать флаги:

- `--dir <path>`
- `--manifest <path>`
- `--dry-run`
- `--apply`
- `--skip-invalid`
- `--truncate-storage`
- `--report <path>`
- `--verbose`

Пример:

```bash
node apps/server/scripts/import-storage-json.mjs --dir ./data/storage --dry-run --report ./import-report.json
node apps/server/scripts/import-storage-json.mjs --dir ./data/storage --manifest ./import-manifest.json --apply --report ./import-report.json
```

## 11.4 Manifest

Manifest нужен, если импортированные данные нужно сразу привязать к auth users.

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

- если `storageKey` не указан, используется `sourceKey`;
- если `userId` указан, importer делает upsert в `user_storage_binding`;
- если `userId` не указан, данные импортируются как standalone storage.

## 11.5 Алгоритм импортёра

Для каждого файла:

1. взять имя файла без `.json` как `sourceKey`;
2. пропустить заведомо служебные и не-storage файлы;
3. распарсить JSON;
4. проверить допустимый top-level shape;
5. нормализовать данные;
6. детерминированно назначить версии;
7. записать сущности в новую схему;
8. создать/обновить alias;
9. optional: создать binding к user по manifest;
10. записать результат в report.

## 11.6 Нормализация при импорте

Импорт должен использовать общую доменную нормализацию, а не отдельную "почти такую же" реализацию.

Нормализация должна:

- гарантировать корректные массивы и profile shape;
- дозаполнять `updatedAt`, если его нет;
- назначать `server_updated_at`;
- назначать `version`;
- вычислять итоговую `server_revision`;
- приводить timestamps к единому формату.

### 11.6.1 Детерминированное присвоение версий

Так как legacy JSON обычно не содержит server version, importer должен присваивать их сам.

Рекомендуемый порядок:

- сначала `profile`;
- затем `workoutTypes` по стабильной сортировке;
- затем `workouts` по `startTime`, потом `id`;
- затем `logs` по `date`, потом `id`.

Это даёт:

- воспроизводимый импорт;
- стабильные отчёты;
- удобную отладку;
- predictable cursor после импорта.

## 11.7 Как обрабатывать мусорные файлы

Если файл:

- невалидный JSON;
- не соответствует storage shape;
- не содержит storage-секций;
- относится к чужому формату данных;

то importer:

- не импортирует его;
- фиксирует это в report;
- либо продолжает, либо останавливается в зависимости от режима.

Это обязательно, потому что в директории с данными могут лежать посторонние JSON.

## 12. Поэтапный план реализации

Ниже описан рекомендуемый порядок работ уже с учётом полного redesign.

## Этап 1. Утвердить новый продуктовый контракт

Нужно:

- зафиксировать, что продуктовый контракт = user scenarios + offline-first;
- зафиксировать отказ от snapshot runtime;
- утвердить, что sync endpoint становится главным runtime API.

Результат:

- команда больше не пытается сохранять старые технические слои.

## Этап 2. Спроектировать новую доменную и SQL-модель

Нужно:

- согласовать таблицы;
- согласовать версии/cursor semantics;
- согласовать alias и public-profile cache;
- решить naming новых модулей.

Результат:

- есть целевая схема БД;
- есть согласованная модель sync.

## Этап 3. Ввести нормальный migration runner

Нужно:

- добавить SQL migrations для backend;
- создать миграции для всех новых storage-таблиц;
- перестать расширять старую giant-schema строку как главный механизм.

Результат:

- schema evolution становится управляемой.

## Этап 4. Переписать backend на delta-oriented storage

Нужно:

- удалить file-backed storage runtime;
- переписать sync service;
- внедрить SQL repositories;
- внедрить row-level locking на `storage_roots`;
- убрать runtime-зависимость от snapshot DTO.

Результат:

- backend работает только на PostgreSQL и только через delta-oriented модель.

## Этап 5. Переписать client sync-слой при необходимости

Так как полный redesign разрешён, можно и нужно улучшить клиентский sync, если текущая реализация мешает.

Нужно:

- сохранить local DB как источник истины для UI;
- сохранить deduplicated dirty/outbox model;
- адаптировать wire contract к новому sync endpoint;
- улучшить обработку конфликтов;
- обеспечить bootstrap через sync с нулевым cursor.

Результат:

- offline-first остаётся, а sync становится архитектурно чище.

## Этап 6. Переписать auth integration

Нужно:

- удалить все legacy file-based ветки;
- оставить deterministic storage binding;
- привязать публичные alias к storage, а не к файловому индексу;
- сохранить auth enrichment профиля.

Результат:

- auth-код больше не зависит от legacy storage.

## Этап 7. Реализовать публичный профиль и AI как отдельные read paths

Нужно:

- вынести lookup публичного профиля в отдельный read model;
- вынести AI context selection в отдельные SQL-запросы;
- перестать читать полный snapshot для этих сценариев.

Результат:

- читающие сценарии становятся быстрыми и локально понятными.

## Этап 8. Написать importer

Нужно:

- реализовать CLI;
- добавить dry-run;
- добавить manifest support;
- добавить report;
- покрыть edge cases тестами.

Результат:

- перенос legacy JSON становится ручной, контролируемой и воспроизводимой операцией.

## Этап 9. Удалить legacy-код и config

Нужно удалить:

- file-backed storage runtime;
- legacy tests на file migration;
- file env vars;
- storage volumes из docker-compose;
- README-секции про filesystem backend;
- compatibility code в auth и public profile.

Результат:

- репозиторий отражает одну актуальную архитектуру, а не две параллельные.

## 13. Тестовая стратегия

## 13.1 Что тестируем в первую очередь

Критичны не старые endpoint'ы, а эти свойства:

- offline-first поведение;
- корректность delta sync;
- отсутствие потери данных при конкуренции;
- корректный bootstrap нового клиента;
- корректный импорт legacy JSON;
- стабильность public profile;
- корректный AI context.

## 13.2 Набор обязательных серверных тестов

- sync с новой сущностью;
- sync с несколькими типами сущностей;
- sync после cursor 0;
- sync с soft delete;
- sync с stale conflict;
- два параллельных sync на один `storageKey`;
- sync и profile enrichment одновременно;
- public profile cache invalidation;
- public profile lookup по alias;
- AI context без полного snapshot.

## 13.3 Набор обязательных клиентских тестов

- локальное создание сущности офлайн;
- повторные локальные изменения одной сущности до сети;
- bootstrap нового клиента через sync;
- применение серверных изменений в local DB;
- конфликтующая sync-ситуация;
- сохранение dirty/outbox state после ошибки сети;
- приложение стартует и рендерится из local DB без ожидания сервера.

## 13.4 Тесты импортёра

- валидный legacy JSON без `version`;
- валидный legacy JSON без `revision`;
- данные без части `updatedAt`;
- пустые коллекции;
- profile без optional-полей;
- soft deleted сущности;
- посторонний JSON в той же директории;
- manifest binding к user;
- dry-run режим;
- apply режим;
- повторный импорт после truncate.

## 13.5 Производительность

Нужно явно проверить:

- sync одной сущности на большой истории;
- bootstrap нового клиента;
- публичный профиль на пользователе с большой историей;
- AI context query на большой истории.

Цель:

- рост истории не должен автоматически означать чтение и сериализацию всего пользовательского состояния.

## 14. План cutover под даунтайм

Так как даунтайм допустим, cutover можно сделать просто и надёжно.

### Шаг 1. Подготовка

- остановить backend;
- снять backup PostgreSQL;
- сохранить архив legacy JSON;
- проверить manifest для importer;
- убедиться, что новая версия backend собрана и готова.

### Шаг 2. Применить SQL migrations

- поднять новую schema;
- проверить наличие всех таблиц и индексов.

### Шаг 3. Прогнать importer в dry-run

- получить полный report;
- проверить skipped/invalid files;
- убедиться, что импорт пойдёт в правильную БД.

### Шаг 4. Выполнить importer в apply

- optional: очистить storage-таблицы;
- выполнить импорт;
- сохранить итоговый report;
- проверить binding и alias.

### Шаг 5. Поднять новую версию backend

- без файлового storage;
- без runtime fallback;
- только с PostgreSQL.

### Шаг 6. Smoke-проверка

Проверить:

- health endpoint;
- логин;
- bootstrap нового клиента;
- офлайн-редактирование и последующий sync;
- публичный профиль;
- AI recommendations;
- Telegram-link/sign-in сценарии.

### Шаг 7. После успешного запуска

- старые JSON оставить только как архив;
- не использовать их больше в runtime;
- не монтировать storage volume в контейнер backend.

## 15. Rollback

Так как runtime compatibility со старым storage не нужна, rollback должен быть развёртывательным, а не кодовым.

Если cutover провален:

1. остановить новую версию backend;
2. восстановить backup PostgreSQL или очистить новые storage-таблицы;
3. вернуть старую версию backend;
4. вернуть старую runtime-конфигурацию;
5. поднять систему на прежней архитектуре.

Именно поэтому до окончательного подтверждения успеха нельзя удалять:

- backup БД;
- legacy JSON;
- manifest;
- importer reports.

## 16. Что должно быть удалено из репозитория после завершения

После успешной миграции в кодовой базе не должно остаться:

- файлового `StorageRepository`;
- кода работы с `fs` для пользовательского storage;
- lazy migration legacy snapshot;
- `username_index.json` логики;
- file-based public profile cache;
- `STORAGE_DIR` и связанного конфига;
- docker volume для storage runtime;
- fallback режима без БД;
- auth-веток, завязанных на legacy JSON;
- тестов, проверяющих file-backed runtime поведение.

## 17. Definition of Done

Миграция считается завершённой, когда:

- backend runtime не зависит от файлового storage;
- PostgreSQL является единственным runtime storage;
- основной runtime сценарий работает через delta-oriented sync;
- клиент остаётся offline-first;
- bootstrap нового клиента делается через sync, а не через snapshot endpoint;
- public profile работает через DB alias + cache/projection;
- AI endpoint не читает полный snapshot пользователя;
- auth-код очищен от legacy storage-веток;
- importer переносит legacy JSON вручную и воспроизводимо;
- тесты подтверждают сохранение пользовательских сценариев;
- конфиги и README соответствуют новой архитектуре.

## 18. Короткая архитектурная формула миграции

Эта миграция означает следующее:

- JSON snapshot перестаёт быть runtime-моделью;
- PostgreSQL становится единственным источником серверной истины;
- IndexedDB остаётся источником истины для UI;
- sync становится delta-oriented и cursor-based;
- пользовательские сценарии сохраняются;
- техническая архитектура полностью обновляется под масштабируемость и надёжность.
