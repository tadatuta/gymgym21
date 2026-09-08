# O07 — формы, доступность и CSP

Общие раскладки форм и весь Login используют CSS-классы, оформление и геометрия графиков теперь определены единственным `.stats-chart`. Индикатор sync не изменён. Убран запрет масштабирования. Подписи связаны с видимыми полями, переключатели и кнопки действий имеют доступные имена. Typeahead сохраняет скрытое `name=typeId` для формы, а публичный `inputId` принадлежит видимому combobox. Добавлены listbox/option, expanded/active-descendant/selected, Escape без потери фокуса; поиск, выбор, черновики и disposal сохранены.

## CSP: решение и границы

`connect-src https:` и wildcard-порты localhost удалены. Vite-плагин берёт уже загруженные `config.env`, добавляет только origins `VITE_AUTH_BASE_URL` / `VITE_API_BASE_URL`; относительные URL используют `self`, protocol-relative URL разрешают точный host/port для HTTP и HTTPS. Из URL не попадают пути, параметры и учетные данные. Для dev добавляются точные WebSocket origins работающего Vite; в production их нет. При смене deployment API URL нужна пересборка, как и для самих Vite-переменных.

Сборщики текущей Метрики — `https://mc.yandex.ru` и `https://mc.yandex.com`; разрешения script/img сохранены, Telegram frame ограничен `https://oauth.telegram.org`. Добавлены `object-src 'none'` и `base-uri 'self'`. Inline bootstrap Метрики и его SHA-256 не менялись. `style-src 'unsafe-inline'` остаётся для существующих динамических стилей и стороннего виджета.

**`script-src 'unsafe-eval'` осознанно сохранён.** В официальном `https://telegram.org/js/telegram-widget.js?22` функция `__parseFunction` (строки 3–6) вызывает `eval`, а ветка `data-onauth` (193–194) использует её. Приложение использует документированный callback входа. Удаление разрешения ломает вход; замена новым протоколом/redirect/обязательным numeric bot ID выходит за CSS/CSP-рефакторинг. Разрешение действует на документ целиком, его нельзя ограничить только Telegram origin. Удалить его можно после отдельной миграции входа с проверкой совместимости. Собственных eval и новых message-handler обходов не добавлено.

Источники: [Telegram Login Widget](https://core.telegram.org/widgets/login/), [официальный JS](https://telegram.org/js/telegram-widget.js?22), [Метрика и CSP](https://yandex.ru/support/metrica/ru/code/install-counter-csp), [Vite 6 Plugin API](https://v6.vite.dev/guide/api-plugin) (Context7). Региональные/дополнительные функции Метрики могут потребовать отдельного обоснованного allowlist; широкие разрешения ради них не добавлялись.

## Проверка

Node 22: client typecheck, lint, 203 unit tests; production Vite/PWA build. `component-lifecycle-browser.mjs` проверяет реальным Chromium label focus, Arrow/Enter/Escape, ARIA, domain ID, переключение временных полей, сохранение черновика после refresh, повторный mount, drag и disposal.

`accessibility-csp-browser.mjs` использует реальный `index.html` и Vite CSP. В dev подменяется только entry для изолированного Login. В `--production` собирается и запускается **настоящий main** со сторонними синтетическими origins auth/API; пройден путь Login → официальный callback виджета → синтетическая session → форма миграции. Сервис-воркеры заблокированы только в контексте теста; их генерация проверена сборкой, runtime PWA здесь не тестируется.

В обоих режимах настоящий скачанный Telegram JS исполняется под CSP; синтетический iframe отправляет сообщение из правильного origin/source, обработанное **официальным** виджетом. Точный официальный `tag.js?id=106707570` исполняет bootstrap с `ssr:true` и делает попытки сбора событий. Все внешние запросы перехвачены, никакие события/аккаунты/учётные данные не отправляются в Telegram, Google, Метрику или production API. Проверены отсутствие неожиданных origins и CSP violations при входе/аналитике, блокирование запроса к постороннему origin, 320/390px layout, связь labels/autocomplete; screenshot 320px просмотрен.

Повторение (предварительно скачать только публичные JS, без telemetry endpoint):

```sh
curl --fail 'https://telegram.org/js/telegram-widget.js?22' -o /tmp/gym21-o07-telegram-widget.js
curl --fail 'https://mc.yandex.ru/metrika/tag.js?id=106707570' -o /tmp/gym21-o07-metrika.js
node audit/accessibility-csp-browser.mjs
node audit/accessibility-csp-browser.mjs --production
node audit/component-lifecycle-browser.mjs
```

Используйте Node 22 и задайте `PLAYWRIGHT_MODULE_PATH` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, если Playwright/Chromium установлены вне проекта. Пути JS можно переопределить `TELEGRAM_WIDGET_PATH` / `METRIKA_SCRIPT_PATH`. Снимки проверенных публичных JS (2026-09-08): Telegram SHA-256 `3c8c27bf6f51a778ed94f452cf6b501f54703b67ef162551f677171916fbcd99`; Метрика `b078df844d9ef78ec4e30cd80e72e6d388d4b830efc1b3cc915afc5c65497f15`. Скрипты сторонних поставщиков в репозиторий не копируются.
