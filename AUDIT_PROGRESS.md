# Исправление замечаний аудита

Цель: исправить все пункты PROJECT_AUDIT.md последовательно, каждый отдельным субагентом и отдельным коммитом. Исходная ревизия: c78452f.

Порядок: A01–A22 (ошибки), S01–S10 (упрощение), O01–O08 (эксплуатация), T01–T06 (проверки). Частично закрытые предыдущими изменениями пункты всё равно отдельно проверяются назначенным субагентом; коммит включает оставшиеся изменения и доказательства.

Пользовательские docker-compose.yml изменения, .vscode/, old-data-storage/, trash/, s.svg сохранять. Не читать секреты и не выполнять проверки на пользовательской БД. Не считать пропущенные внешние/интеграционные проверки успешными.

| ID | Задача | Статус | Субагент / коммит | Проверки |
| --- | --- | --- | --- | --- |
| A01 | P1 — Можно переназначить чужую публичную ссылку через профиль | Завершено | audit_01_alias_ownership / e79d9e9 | Node22: typecheck обоих workspaces; npm test с изолированной PostgreSQL: 28/28, без skipped; реальный auth resolver, HTTP sync, concurrent auth/public alias claims |
| A02 | P1 — Telegram-вход доверяет совпадению с неподтверждённым техническим email | Завершено | audit_02_telegram_email / 836109f | Node22: server build; npm test с изолированной PostgreSQL: 35/35 без skipped; реальные auth endpoints signup/change/update/migration, legacy collision 409 без захвата, безопасная migration + explicit Telegram link, concurrent first login и повторный вход по provider binding |
| A03 | P1 — Пустая синхронизация может навсегда застрять на старом ответе | Завершено | audit_03_sync_receipts / d3f1a39 | Node22: typecheck обоих workspaces; npm test с изолированной PostgreSQL 40/40 без skipped; client sync tests 4/4 (outbox generation rebasing). Два клиента, legacy empty/full receipts, потерянный ответ push, свежие submitted entities при advanced cursor, актуальная conflict serverVersion, concurrent retries без повторного применения. Receipts содержат только push outcome; pull всегда свежий. |
| A04 | P1 — Сетевые операции не привязаны к неизменной идентичности аккаунта | Завершено | audit_04_account_context / 7e94398 | Node22: typecheck, client lint, client tests 40/40; server+изолированная PostgreSQL 41/41 без skipped. Account-scoped sync instance, generation/abort, guards AI/public cache и auth late401/restore; общий auth channel без rebroadcast на session reads; обязательный expected-storage header/CORS. Реальный auth resolver с signed cookie B отвергает A/missing identity для sync/AI до effects, обе snapshots неизменны; B sync проходит. Browser multi-tab E2E остаётся T05. |
| A05 | P1 — После офлайн-запуска возвращение сети не возобновляет авторизацию и sync | Завершено | audit_05_reconnect / df7a40d | Node22: client typecheck, lint, tests 46/46. Единый bootstrap/online/manual reconnect singleflight: restore → migration user/storage identity → activate → sync. Unavailable сохраняет локальные данные, no-session показывает login без rebroadcast. Регрессии coordinator с подменёнными зависимостями: offline save→online, другой cookie account, смена cookie между restore/status, concurrent online/manual, stale auth/dispose. Реальный browser/IndexedDB/server reconnect E2E остаётся T05. |
| A06 | P1 — JSON-импорт не выполняет обещанную замену данных | Завершено | audit_06_backup_semantics / c32d759 | Явные merge/replace; versioned backup без sync metadata + legacy normalization. Authenticated atomic endpoint: expected revision под root lock, серверные versions и tombstones; полный fresh sync, generation-aware apply, блокировка offline replace, offline merge pending/conflicts. Node22: typecheck обоих workspaces, client lint, client tests 52/52. Полный server+isolated PostgreSQL suite 46/46 без skipped; расширенный backup suite 6/6 отдельно: два клиента A+B/file modified A, все tombstones, trusted profile identity, concurrent 409 без изменений, validation/account guard. Client fake-IDB: новая generation сохраняется, failed preflight cache refresh, offline merge/rejection. Полная validation/escaping — A07, browser E2E — T05. |
| A07 | P1 — Импорт допускает некорректные типы и HTML в числовых полях | Завершено | audit_07_backup_validation / 44ddc09 | Полная runtime validation legacy/envelope до preflight и любых записей; поля ошибок, finite/ranges/integer/calendar/dates/nested shapes/unique bounded IDs. Backup endpoint повторно проверяет данные; blank birthDate нормализуется. Escaping чисел и остальных данных в HTML/SVG main/components независимо от TS. Node22: typecheck обоих workspaces, client lint, client tests 86/86 (11 файлов), production client build (432.34 kB / gzip 134.89 kB), server+isolated PostgreSQL 49/49 без skipped. Все IDB tables/outbox неизменны при 27 malformed cases × online/offline × merge/replace; HTTP malformed imports 400/no changes, valid orphan roundtrip обоих режимов. Orphan IDs сознательно сохраняются: удаление типов сохраняет logs, legacy workouts отсутствуют; отсутствующие targets допустимы, формы ссылок проверяются, targets не синтезируются. DOM проверен через реальные extracted main renderers (временный AST seam до S01); дубли backup schema клиент/сервер до S04; general sync validation остаётся A22, браузерный E2E — T05. |
| A08 | P1 — Фоновые обновления уничтожают несохранённый ввод | Завершено | audit_08_form_drafts / f21a004 | Memory-only drafts keyed account+route/tab+form/entity; values/select/radio/checkbox/typeahead query+ID, focus/selection; успешный submit очищает только отправленное поколение, новый ввод во время await остаётся, cancel/edit target/account/logout очищают drafts. AI options сохраняются отдельно от успешно сохранённых личных данных. Все full/partial main/profile/settings/workout updates защищены; убраны лишние renders pause/resume/finish/conflicts. reloadCache всегда обновляет snapshot metadata, но callback только при domain/account/conflict change; identity/tombstones не исключены. Node22: client typecheck, lint, production build (437.64 kB / gzip 136.57 kB), client tests 98/98 (12 файлов). 10 actual-main DOM regressions через временный AST seam: new/edit log+workout/type, typeahead focus/selection+dropdown, profile public/AI/data, routes/accounts, save/cancel/target switch, async newer input, start→finish. Fake-IDB проверки metadata-only/no-op reload без callback, identity/conflicts/account change с callback. Исправлен flaky A07 orphan roundtrip assertion: portable domain сравнивается без заново созданного updatedAt. Browser sync/visibility E2E остаётся T05; split/lifecycle компонентов — S01/S06, full-cache canonical O(N) — O01; drafts намеренно не сохраняются после reload страницы. |
| A09 | P1 — Ошибка выхода из аккаунта может быть принята за успех | Завершено | audit_09_signout / текущий коммит | Durable unique pending intent до запроса; identity/cache/drafts блокируются синхронным auth event, offline accounts остаются. Проверка SDK error и success=true; startup/reconnect сохраняет pending при unavailable и не читает старую cookie. Очередь cookie mutations + Web Locks, вход сначала завершает pending; более поздний logout отменяет queued login, старый ответ не удаляет новый marker. Node22: typecheck обоих workspaces, client lint, client103/103 (13 файлов), server+isolated PostgreSQL49/49 без skipped. Real installed BetterAuth SDK с HTTP Response503/rejected network/Response200, mock immediate lock/reload/repeated failure/reconnect/new B/newer marker/queued login cancellation. Межвкладочная сериализация требует Web Locks; без него действует очередь текущей вкладки. Реальные browser cookie/header races и offline reconnect E2E — T05; SDK test подменяет transport, real auth endpoints — T04. |
| A10 | P1 — Импортёр очищает серверное хранилище до проверки входных данных | Ожидает | — | — |
| A11 | P2 — Размер push не ограничен пачками, а pull с push игнорирует limit | Ожидает | — | — |
| A12 | P2 — Нет автоматического восстановления после временных ошибок sync | Ожидает | — | — |
| A13 | P2 — «Повторить последний подход» выбирает запись по ID | Ожидает | — | — |
| A14 | P2 — Публичная статистика считает подходы за последние 14 активных дней как тренировки | Ожидает | — | — |
| A15 | P2 — Даты и длительности вычисляются несколькими несовместимыми способами | Ожидает | — | — |
| A16 | P2 — Markdown-экспорт теряет записи, а нулевой график создаёт NaN | Ожидает | — | — |
| A17 | P2 — Заявленная интеграция Telegram Mini App не подключена на клиенте | Ожидает | — | — |
| A18 | P2 — Публичные ссылки неполноценны для гостя и Telegram ID | Ожидает | — | — |
| A19 | P2 — Dev-команда сервера не работает с текущей структурой модулей | Ожидает | — | — |
| A20 | P2 — Docker-конфигурация не передаёт заявленные настройки ограничений | Ожидает | — | — |
| A21 | P2 — Таймаут AI не отменяет вычисление; контекст может быть устаревшим | Ожидает | — | — |
| A22 | P1 — Пустая дата рождения блокирует sync профиля; валидация HTTP неполна | Ожидает | — | — |
| S01 | Разделить main.ts по сценариям | Ожидает | — | — |
| S02 | Разделить локальные доменные операции и sync scheduling | Ожидает | — | — |
| S03 | Выделить серверные sync и SQL/read repositories | Ожидает | — | — |
| S04 | Общий пакет runtime-контрактов | Ожидает | — | — |
| S05 | Один индикатор и подписка sync | Ожидает | — | — |
| S06 | Lifecycle и освобождение обработчиков компонентов | Ожидает | — | — |
| S07 | Общий auth identity и транзакции | Ожидает | — | — |
| S08 | Удалить мёртвый код | Ожидает | — | — |
| S09 | Удалить неработающие compatibility-настройки | Ожидает | — | — |
| S10 | Привести зависимости к использованию | Ожидает | — | — |
| O01 | Инкрементальные IndexedDB-чтения и UI lookup | Ожидает | — | — |
| O02 | Ограниченные public/AI запросы и SQL EXPLAIN | Ожидает | — | — |
| O03 | Единый migration runner и блокировка | Ожидает | — | — |
| O04 | Docker context и production image | Ожидает | — | — |
| O05 | Readiness, timeouts, shutdown и общий rate limit | Ожидает | — | — |
| O06 | Проверка TLS PostgreSQL | Ожидает | — | — |
| O07 | CSS, доступность и CSP | Ожидает | — | — |
| O08 | Актуальные документация и локальные артефакты | Ожидает | — | — |
| T01 | Единая команда проверок и server lint | Ожидает | — | — |
| T02 | CI на Node 22 | Ожидает | — | — |
| T03 | Интеграционные PostgreSQL repository tests | Ожидает | — | — |
| T04 | Интеграционные auth endpoint tests | Ожидает | — | — |
| T05 | Браузерные offline/account/form/import/PWA сценарии | Ожидает | — | — |
| T06 | Общие contract fixtures без копирования бизнес-логики | Ожидает | — | — |

## Итоговая проверка

- [ ] Все 46 пунктов имеют отдельного субагента, коммит и проверяемый результат.
- [ ] Проверены Node 22, типы, lint, обе группы tests и production build.
- [ ] Пройдены изолированные PostgreSQL и браузерные integration tests.
- [ ] Проверены оставшиеся ограничения внешних сервисов и зависимостей.
- [ ] Изменения пользователя сохранены, секреты и данные не закоммичены.
- [ ] Каждый пункт исходного отчёта повторно сверен с итоговым кодом.
