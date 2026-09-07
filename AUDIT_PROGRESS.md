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
| A06 | P1 — JSON-импорт не выполняет обещанную замену данных | Завершено | audit_06_backup_semantics / текущий коммит | Явные merge/replace; versioned backup без sync metadata + legacy normalization. Authenticated atomic endpoint: expected revision под root lock, серверные versions и tombstones; полный fresh sync, generation-aware apply, блокировка offline replace, offline merge pending/conflicts. Node22: typecheck обоих workspaces, client lint, client tests 52/52. Полный server+isolated PostgreSQL suite 46/46 без skipped; расширенный backup suite 6/6 отдельно: два клиента A+B/file modified A, все tombstones, trusted profile identity, concurrent 409 без изменений, validation/account guard. Client fake-IDB: новая generation сохраняется, failed preflight cache refresh, offline merge/rejection. Полная validation/escaping — A07, browser E2E — T05. |
| A07 | P1 — Импорт допускает некорректные типы и HTML в числовых полях | Ожидает | — | — |
| A08 | P1 — Фоновые обновления уничтожают несохранённый ввод | Ожидает | — | — |
| A09 | P1 — Ошибка выхода из аккаунта может быть принята за успех | Ожидает | — | — |
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
