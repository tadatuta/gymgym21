# Проверки и доказательства аудита

Текущий статус пунктов — [AUDIT_PROGRESS](../AUDIT_PROGRESS.md), обычные команды — [runbook](../docs/runbook.md). Исходный [PROJECT_AUDIT](../PROJECT_AUDIT.md) описывает историческую ревизию от 6 сентября 2026, а не текущий список неисправностей.

`reproduce*.mjs` сохраняют исходные воспроизведения дефектов и могут ожидать ошибочное поведение. Не запускайте их как текущий CI или доказательство регрессии до переработки в T06. Наличие файла не означает, что он поддерживает текущую архитектуру. Остальные скрипты — адресные проверки с собственными зависимостями (Docker, отдельная PostgreSQL, Playwright); не запускайте их массово без чтения условий. T01–T02 завершены: `npm run check` объединяет проверки пакетов; `npm run test:integration` требует отдельную PostgreSQL; [CI](../.github/workflows/ci.yml) выполняет обе команды после `npm ci` на Node 22 с PostgreSQL 16 service. Удалённый запуск CI ещё не выполнялся; TLS fixture запускается отдельно; T05 добавляет установку Chromium и bounded `npm run test:browser` в workflow. T03: реальный repository проверен по [матрице PostgreSQL](postgres-tests.md); T04: [настоящие auth endpoints и logout503](auth-endpoints.md); T05: [браузерный suite, offline/accounts/import и настоящий SW lifecycle](browser-tests.md); T06 ещё не завершён.

Сохранённые отчёты об исправлениях и границах проверок:

- [Зависимости и npm audit](dependencies.md).
- [Кэш и производительность](cache-performance.md).
- [Публичные SQL-чтения](public-query-performance.md).
- [Docker runtime](docker-runtime.md).
- [Таймауты, readiness, rate limits и аренды](runtime-limits.md).
- [PostgreSQL repository и матрица покрытия](postgres-tests.md).
- [Настоящие auth endpoints и Chromium logout503](auth-endpoints.md).
- [Браузерный suite и настоящий PWA lifecycle](browser-tests.md).
- [PostgreSQL TLS](postgres-tls.md).
- [Доступность и CSP](accessibility-csp.md).

Отчёты фиксируют результат в момент соответствующего коммита; они не заменяют повторную проверку после изменения кода. Дополнительные браузерные, packaging и dev lifecycle сценарии описаны в runbook и [клиентской документации](../apps/client/README.md). Для проверок используйте синтетические данные и отдельную тестовую БД; рабочие секреты и пользовательские архивы не нужны.
