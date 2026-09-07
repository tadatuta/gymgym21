# Ревизия Gym21 — 6 сентября 2026

Проверена рабочая копия на основе коммита `c78452f`: клиент, сервер, синхронизация, авторизация, SQL-схема, импортёр, сборка, Docker/Nginx, тесты и документация. Главные проблемы находятся в корректности синхронизации, границах аккаунтов и доверии к данным профиля. Упрощение стоит начать после исправления этих ошибок: разбиение больших файлов само по себе их не устранит.

Исходный код и пользовательские данные при ревизии не изменялись. Добавлены этот отчёт и автономные сценарии воспроизведения в `audit/`. Существующие изменения `docker-compose.yml`, `.vscode/`, `old-data-storage/`, `trash/` и `s.svg` не изменялись. Содержимое пользовательских JSON и секретов для аудита не использовалось.

## Проверки и границы достоверности

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | Проходит для обоих приложений |
| `npm run test --workspace @gym21/client` | 35 тестов, 8 файлов, проходят |
| `npm test` | 18 серверных тестов проходят; потребовалось разрешение локального HTTP-порта вне песочницы |
| `npm run lint --workspace @gym21/client` | Проходит |
| `npm run build` | Проходит; основной JS: 355,47 kB, gzip 113,70 kB |
| Дополнительная проверка сервера с `noUnusedLocals` / `noUnusedParameters` | Находит 3 неиспользуемых объявления |
| Запуск `node apps/server/src/server.ts`, используемый dev-скриптом | `ERR_MODULE_NOT_FOUND`: отсутствует `src/ai.js` |
| Автономные воспроизведения на исходных модулях | 11 проверок подтверждают отдельные дефекты; детали ниже |
| `npm audit` | Результат получить не удалось: после снятия ограничения песочницы реестр ответил сетевой ошибкой `socket hang up` |

Проверки выполнены на установленном Node.js **25.2.1**, тогда как проект заявляет **22.x**. Это не заменяет CI на целевой версии. Настоящие PostgreSQL, Telegram, Passkey, Vertex AI и production-развёртывание не использовались; браузерные сценарии на телефоне не проходились. Серверные воспроизведения используют реальный код и подменённый SQL-адаптер, поэтому подтверждают ветвления и сформированные запросы, но не являются интеграционными тестами PostgreSQL. Отсутствие уязвимостей зависимостей не подтверждено.

Приоритеты: **P1** — исправить до следующего выпуска; **P2** — плановое исправление поведения или надёжности; **P3** — обслуживание и упрощение. «Подтверждено воспроизведением» означает отдельную исполняемую проверку; остальные выводы основаны на прослеживании кода.

## Ошибки, которые нужно исправить

### 1. P1 — Можно переназначить чужую публичную ссылку через профиль

Места: [схема входного профиля](/Users/tadatuta/projects/gym21/apps/server/src/http/routes/me.ts:46), [нормализация](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:233), [обновление aliases](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:798).

Обычный пользователь с cookie-сессией может передать `telegramUsername` произвольного человека в sync. У такого запроса нет `authContext.telegramUser`, поэтому сервер сохраняет переданное значение. Затем `refreshPublicAliases` выполняет `ON CONFLICT ... DO UPDATE SET storage_key = EXCLUDED.storage_key` и переводит существующую ссылку на другое хранилище. Наличие отдельного реестра `user_alias` этому пути не мешает.

**Рекомендация:** исключить поля подтверждённой идентичности из пользовательского sync-профиля; получать их только из связанных auth accounts. Обновление alias должно допускаться только текущим владельцем. Проверку владения и запись выполнять атомарно. Объединить правила владения для `user_alias` и `public_profile_aliases`.

**Проверка исправления:** пользователь A отправляет `telegramUsername` пользователя B; ссылка B остаётся у B. Подмена поля и SQL, перезаписывающий владельца, подтверждены автономным воспроизведением; атака на живую БД не выполнялась.

### 2. P1 — Telegram-вход доверяет совпадению с неподтверждённым техническим email

Места: [проверка email](/Users/tadatuta/projects/gym21/apps/server/src/auth.ts:237), [Telegram sign-in](/Users/tadatuta/projects/gym21/apps/server/src/auth.ts:577), [регистрация](/Users/tadatuta/projects/gym21/apps/server/src/auth.ts:715), [placeholder email](/Users/tadatuta/projects/gym21/apps/server/src/auth-meta.ts:151).

Регистрация принимает адрес вида `telegram-12345@telegram.local.invalid` без подтверждения email. При первом Telegram-входе код ищет этот адрес и использует найденный `userId`, даже если аккаунт был создан посторонним через парольную регистрацию. В этой ветке дополнительно пропущен `linkTelegramAccountTx`. Получается неявное объединение идентичностей по адресу, которым никто не доказал владение.

**Рекомендация:** запретить технический домен во всех внешних способах регистрации и изменения email. Telegram-идентичность определять через уникальную пару provider/account ID; существующие технические аккаунты переносить через отдельную проверяемую миграцию. Не присоединять аккаунт по неподтверждённому email. Проверить также стандартные endpoints включённого auth-провайдера, а не только собственный `/register/email`.

**Проверка исправления:** предварительная регистрация технического email запрещена; Telegram-вход не получает чужой аккаунт по совпадению email. Приём такого адреса текущим валидатором проверен; полный сценарий авторизации с реальной БД не выполнялся.

### 3. P1 — Пустая синхронизация может навсегда застрять на старом ответе

Места: [batch ID](/Users/tadatuta/projects/gym21/apps/client/src/services/sync.ts:77), [чтение receipt](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:1210), [сохранение receipt](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:1438).

`batchId` зависит от cursor и поколений локальных изменений. При пустой очереди и неизменном cursor каждый новый pull получает тот же ID. Сервер сохраняет и воспроизводит полный ответ даже для запроса без изменений. После пустого ответа на cursor N новые данные другого устройства уже не читаются: сервер возвращает старый receipt с N. Проверка срока хранения выполняется после этой ранней ветки, поэтому сама по себе не гарантирует выход из зависания.

**Рекомендация:** не сохранять receipts для чистого pull. Для push хранить результат применения конкретной пачки, а актуальный pull вычислять отдельно. Успешно завершённый запрос и повтор запроса после потери ответа должны различаться.

**Проверка исправления:** A делает пустой sync, B добавляет запись, следующий пустой sync A получает запись B без локального редактирования. Повтор ID и возврат старого cursor реальным repository подтверждены воспроизведением.

### 4. P1 — Сетевые операции не привязаны к неизменной идентичности аккаунта

Места: [глобальная сменяемая БД](/Users/tadatuta/projects/gym21/apps/client/src/db.ts:69), [применение ответа](/Users/tadatuta/projects/gym21/apps/client/src/services/sync.ts:88), [проверка аккаунта в памяти](/Users/tadatuta/projects/gym21/apps/client/src/auth.ts:268), [fetch с общей cookie](/Users/tadatuta/projects/gym21/apps/client/src/auth.ts:512).

Sync читает из глобального `db`, ждёт сеть и записывает ответ снова через глобальный `db`. После смены активной базы запоздавший ответ A записывается в B — это подтверждено воспроизведением. Аналогичный принцип используется при сохранении AI-ответа и публичного кэша.

Есть и риск между вкладками: вкладка A сохраняет старую сессию в памяти, а вход в B в другой вкладке меняет общую cookie. `hasVerifiedOnlineAccount` сравнивает только объекты в памяти; сервер выбирает аккаунт по актуальной cookie. Запрос не содержит проверяемой сервером ожидаемой идентичности, что создаёт путь отправки локальных данных A в B. Этот сценарий выведен из кода и требует браузерного интеграционного теста.

**Рекомендация:** передавать в операции экземпляр account-scoped repository и поколение аккаунта; отменять операции при выходе/смене; не применять устаревшие ответы. Передавать ожидаемый storage/account ID и на сервере сравнивать его с авторизованным контекстом. Сообщать о смене входа другим вкладкам через общий auth channel.

### 5. P1 — После офлайн-запуска возвращение сети не возобновляет авторизацию и sync

Места: [offline bootstrap](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:2295), [обработчик online](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:98), [условие планирования sync](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:315).

При неуспешной сетевой проверке сессии `initApp` оставляет локальный аккаунт и завершает работу. `currentSession` остаётся пустой. После появления сети обработчик вызывает только `scheduleSync`, который сразу отказывает без `hasVerifiedOnlineAccount`. Повторного `restoreSessionState` нет. Изменения остаются локальными до перезагрузки страницы.

**Рекомендация:** единый процесс reconnect: восстановить сессию → проверить привязку аккаунта → запустить sync. Использовать его при возвращении сети и повторной попытке пользователя. Отличать недоступный сервер от отсутствия сессии.

**Проверка исправления:** открыть установленную PWA без сети, добавить подход, включить сеть — запись появляется на сервере без reload.

### 6. P1 — JSON-импорт не выполняет обещанную замену данных

Места: [обещание в UI](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:1719), [импорт](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:969), [сравнение версий на сервере](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:1260).

Импорт очищает только IndexedDB, сбрасывает cursor и отправляет импортированные сущности через обычный sync. Для отсутствующих в файле серверных записей tombstones не создаются — они возвращаются при pull. Импортированные старые `version` конфликтуют с текущим сервером, поэтому часть восстановленного файла заменяется серверными версиями. Это особенно неприятно при восстановлении старого бэкапа своего же аккаунта.

**Рекомендация:** явно определить два режима — объединение и восстановление с заменой. Для замены нужна серверная операция с согласованными версиями/удалениями либо предварительно рассчитанная полная дельта с tombstones и актуальными версиями. Отделить backup-формат от wire-формата sync; не считать версии из произвольного файла актуальными серверными версиями.

**Проверка исправления:** сервер содержит A+B, файл содержит изменённую A; после восстановления и синхронизации результат соответствует выбранному режиму, включая другие устройства.

### 7. P1 — Импорт допускает некорректные типы и HTML в числовых полях

Места: [валидация импорта](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:969), [HTML подходов](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:886), [HTML формы](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:520).

Проверяется только наличие `logs` и `workoutTypes`. Строка с HTML в `weight` успешно попадает в IndexedDB, хотя TypeScript описывает поле как число. Далее числовые значения вставляются в HTML без экранирования. Подтверждён приём HTML-строки; исполнение JavaScript в браузере под текущим CSP не проверялось. Даже без исполнения JS это позволяет подменять разметку. Неверные даты и формы объектов могут ломать рендер и блокировать всю очередь sync.

**Рекомендация:** проверять весь файл до очистки базы: версию формата, массивы, уникальные IDs, ссылки сущностей, даты, конечные числа и допустимые диапазоны. Ошибки сообщать с указанием записи и поля. Экранировать все значения HTML-шаблонов независимо от статических типов. Сохранить атомарную транзакцию импорта.

### 8. P1 — Фоновые обновления уничтожают несохранённый ввод

Места: [полное чтение кэша и callback](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:447), [подписчик UI](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:2273), [рендер приложения](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:222), [перерисовка профиля](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:1311).

Любой `reloadCache`, включая sync без изменений и возвращение вкладки на экран, вызывает обновление UI. Главная страница заменяется через `app.innerHTML`, профиль — через `container.innerHTML`. Значения формы существуют только в DOM и теряются. Ручные «частичные обновления» после mutation не помогают: полная перерисовка уже произошла внутри `commitMutation`.

**Рекомендация:** хранить черновики форм отдельно; обновлять только затронутые списки/показатели. Не уведомлять UI при отсутствии доменных изменений. Убрать дублирующий рендер из обработчиков после mutations. Сохранять фокус и выбранное упражнение.

**Проверка исправления:** начать ввод подхода/профиля, дождаться sync или переключить вкладку и вернуться — введённые значения и фокус сохраняются.

### 9. P1 — Ошибка выхода из аккаунта может быть принята за успех

Место: [signOut и pending sign-out](/Users/tadatuta/projects/gym21/apps/client/src/auth.ts:335).

Оба вызова `authClient.signOut()` проверяют исключение, но игнорируют возвращённый `result.error`. Используемый fetch-клиент при HTTP-ошибке по умолчанию возвращает объект ошибки. При 503 pending-флаг не ставится или преждевременно удаляется, а серверная cookie остаётся. Следующее восстановление сессии может снова открыть аккаунт, из которого пользователь вышел.

**Рекомендация:** проверять `result.error`; сохранять pending-флаг до подтверждённого выхода. При pending sign-out не разрешать восстановление старой cookie-сессии. Дополнить существующий тест случаем resolved `{ error }`, а не только rejected Promise. Текущий дефект подтверждён воспроизведением с таким ответом.

### 10. P1 — Импортёр очищает серверное хранилище до проверки входных данных

Места: [порядок операций](/Users/tadatuta/projects/gym21/apps/server/scripts/import-storage-json.mjs:140), [запись snapshot и binding](/Users/tadatuta/projects/gym21/apps/server/scripts/import-storage-json.mjs:182).

`--apply --truncate-storage` выполняет TRUNCATE до чтения manifest, проверки директории и валидации файлов. Опечатка в пути или испорченный первый JSON обнаруживается уже после очистки. Запись snapshot и binding проходят отдельно: ошибка binding оставляет частично применённый импорт. Повторный импорт одного storage также сбрасывает revision, не удаляя его старые receipts и не сбрасывая cursors существующих клиентов.

**Рекомендация:** сначала полностью проверить файлы, manifest, существование пользователей и коллизии storage keys. Только затем применять согласованный план. Обеспечить атомарность snapshot+binding; для массовой замены использовать staging/транзакционную схему. Повторную загрузку ограничить новым хранилищем либо ввести явный reset поколения sync. `--dry-run` не должен автоматически применять SQL-схему.

### 11. P2 — Размер push не ограничен пачками, а pull с push игнорирует limit

Места: [сбор всей очереди](/Users/tadatuta/projects/gym21/apps/client/src/services/sync.ts:200), [лимит logs](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:173), [условная пагинация](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:1380), [proxy](/Users/tadatuta/projects/gym21/infra/nginx/nginx.conf:1).

Клиент отправляет весь outbox. Сервер отвергает больше 10 000 logs в запросе, поэтому такая очередь не уменьшается. Для push-запроса limit pull не применяется и сервер возвращает всю накопившуюся дельту. Лимит тела Nginx не согласован с `JSON_BODY_LIMIT` сервера: явного `client_max_body_size` нет.

**Рекомендация:** ограничить push по числу сущностей и сериализованному размеру; подтверждать только отправленную пачку. Пагинировать pull независимо от push. Согласовать лимиты proxy/API и проверить большой импорт, а не только обычные одиночные изменения.

### 12. P2 — Нет автоматического восстановления после временных ошибок sync

Места: [fetch и ошибки](/Users/tadatuta/projects/gym21/apps/client/src/services/sync.ts:94), [планировщик](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:330).

У запроса нет timeout/отмены. При зависшей сети `syncInFlight` удерживается неопределённо долго. После 429/503/сбоя сети повтор не планируется, если во время запроса не возникло ещё одной mutation. `Retry-After`, code и details превращаются в общее `Sync failed`. Одна невалидная сущность может блокировать всю пачку без понятного объяснения.

**Рекомендация:** timeout с отменой запроса; повтор с увеличением интервала и случайной добавкой; уважать `Retry-After`. Различать ошибки авторизации, временные ошибки и ошибки данных. Показывать число несинхронизированных записей и проблемную запись.

### 13. P2 — «Повторить последний подход» выбирает запись по ID

Места: [readAll](/Users/tadatuta/projects/gym21/apps/client/src/services/sync.ts:190), [выбор последнего](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:480), [повтор подхода](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:2113).

`db.logs.toArray()` возвращает записи по первичному ключу, а UI выбирает `logs[logs.length - 1]`. При UUID порядок не соответствует времени. Повторяется старый подход и выбирается неверное упражнение по умолчанию. Подтверждено на двух записях с противоположными порядками ID и date.

**Рекомендация:** отдельный `getLatestLog()` с сортировкой по date и стабильным разрешением совпадений; не делать порядок произвольного массива частью неявного контракта.

### 14. P2 — Публичная статистика считает подходы за последние 14 активных дней как тренировки

Места: [агрегация](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:765), [подпись показателя](/Users/tadatuta/projects/gym21/apps/client/src/components/profile/ProfileStats.ts:24).

`recentActivity` обрезается до 14 дней, а `totalWorkouts` суммирует число logs только в этом фрагменте. При этом общий объём берётся за всю историю. 20 тренировок по одному подходу в разные дни дают «14 тренировок»; одна тренировка с несколькими подходами считается несколько раз. Первый случай подтверждён воспроизведением.

**Рекомендация:** определить показатель как число сессий или число тренировочных дней, вычислять его по всей истории и отдельно считать активность для графика. Использовать одно правило в собственном и публичном профиле.

### 15. P2 — Даты и длительности вычисляются несколькими несовместимыми способами

Места: [агрегации статистики](/Users/tadatuta/projects/gym21/apps/client/src/utils/statistics.ts:14), [группировка истории](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:799), [длительность](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:635), [редактирование подхода](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:2053).

- Статистика использует UTC-день через `split('T')[0]`, история показывает локальные дни. Например, 00:30 Москвы попадает в предыдущий UTC-день.
- Сессии без явного старта объединяются по UTC-дню; редактирование даты подхода не пересчитывает границы его неявной тренировки.
- Длительность в карточке учитывает введённые минуты, а график и среднее — только разницу start/end с паузами. `durationSeconds` при суммировании карточки теряется.
- При редактировании 30 секунд в 0 поле удаляется из `logData`, но затем старое значение возвращается через `{ ...existingLog, ...logData }`. Аналогично могут сохраняться поля прежнего типа упражнения.

**Рекомендация:** единые чистые функции для ключа дня и длительности, согласованная временная зона, единая модель длительности. Формировать обновляемый подход целиком с явным удалением неприменимых полей; пересчитывать связанные границы в той же транзакции. Добавить проверки полуночи, секунд→0 и переноса подхода на другой день.

### 16. P2 — Markdown-экспорт теряет записи, а нулевой график создаёт NaN

Места: [экспорт](/Users/tadatuta/projects/gym21/apps/client/src/utils/export.ts:60), [столбчатый график](/Users/tadatuta/projects/gym21/apps/client/src/components/stats/Charts.ts:99).

Экспорт обходит только непустые `workoutId`, поэтому старые/orphan logs без workoutId исчезают. UI такие записи поддерживает. В графике два дня с нулевым объёмом дают деление `0 / 0` и невалидные SVG-координаты. Оба случая подтверждены воспроизведениями.

**Рекомендация:** отдельная группа для logs без сессии; безопасная шкала или явное пустое состояние для нулевых значений. Проверять сохранность числа подходов при экспорте.

### 17. P2 — Заявленная интеграция Telegram Mini App не подключена на клиенте

Места: [Login](/Users/tadatuta/projects/gym21/apps/client/src/components/auth/Login.ts:150), [HTML entry](/Users/tadatuta/projects/gym21/apps/client/index.html:1), [README](/Users/tadatuta/projects/gym21/apps/client/README.md:1).

Клиент использует Telegram Login Widget, но не читает `Telegram.WebApp.initData` и не подключает WebApp SDK. Упомянутый в README `telegram-mock.ts` отсутствует. Поддержка Mini App на сервере и тест HMAC не обеспечивают клиентский Mini App flow.

**Рекомендация:** восстановить автоматический обмен Mini App initData на общую cookie-сессию либо убрать обещание TMA из текущей документации. Это продуктовая развилка, а не повод сохранять две независимые модели авторизации.

### 18. P2 — Публичные ссылки неполноценны для гостя и Telegram ID

Места: [bootstrap](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:2295), [ограничение render](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:226), [публичный кэш](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:846), [aliases](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:798).

API публичен, но гостю клиент показывает вход: router запускается после активации аккаунта, а чтение публичного профиля требует активную личную БД. Кроме того, auth создаёт `id_<telegramUserId>` в `user_alias`, а публичный resolver использует только `public_profile_aliases`, где такого ID нет для storage `u_<uuid>`. Несоответствие ID подтверждено воспроизведением.

**Рекомендация:** публичный маршрут должен уметь открываться до личного bootstrap; кэш сделать опциональным. Использовать единый источник соответствия идентификатора аккаунту, сохранив проверку `isPublic`.

### 19. P2 — Dev-команда сервера не работает с текущей структурой модулей

Места: [package scripts](/Users/tadatuta/projects/gym21/apps/server/package.json:7), [imports](/Users/tadatuta/projects/gym21/apps/server/src/server.ts:3), [config](/Users/tadatuta/projects/gym21/apps/server/src/config.ts:1).

`node --watch src/server.ts` запускает TypeScript с imports `./ai.js`, `./app.js` и т. п., но в src лежат только `.ts`. Сам запуск падает до подключения БД. Также команды локального запуска не загружают `.env`, хотя конфигурация читается только из `process.env`.

**Рекомендация:** выбрать один работающий путь dev: watcher компилятора + запуск dist либо TypeScript runner с соответствующим разрешением модулей. Явно настроить загрузку env и закрепить Node 22 в окружении разработки/CI. Проверять старт на чистом checkout по README.

### 20. P2 — Docker-конфигурация не передаёт заявленные настройки ограничений

Места: [environment сервера](/Users/tadatuta/projects/gym21/docker-compose.yml:26), [config](/Users/tadatuta/projects/gym21/apps/server/src/config.ts:63), [upstream](/Users/tadatuta/projects/gym21/infra/nginx/nginx.conf:8).

Корневая `.env.example` документирует `RATE_LIMIT_*` и `AI_*`, но compose их не передаёт серверу. Изменение `.env` не меняет соответствующие значения контейнера. `PORT` configurable, однако Nginx всегда обращается к 8788. В рабочей копии PostgreSQL опубликован как `5432:5432`, а fallback-пароль — `gym21`; это локальное незакоммиченное изменение, а не утверждение о production.

**Рекомендация:** передавать все поддерживаемые настройки явно и проверять итоговую конфигурацию; зафиксировать внутренний порт либо согласовать его с proxy. Для локального доступа к БД использовать dev override с loopback-адресом; production не должен публиковать БД наружу и принимать дефолтный пароль.

### 21. P2 — Таймаут AI не отменяет вычисление; контекст может быть устаревшим

Места: [withTimeout](/Users/tadatuta/projects/gym21/apps/server/src/ai.ts:43), [вызов модели](/Users/tadatuta/projects/gym21/apps/server/src/ai.ts:184), [клиентский AI-запрос](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:893).

Таймер отклоняет обёртку Promise, но исходная операция продолжается. После ответа 503 серверный счётчик in-flight освобождается, хотя предыдущая генерация ещё может выполняться. Перед AI-запросом клиент не дожидается отправки свежих изменений; сервер читает только свою БД. Пользователь может сохранить новые параметры и немедленно получить анализ предыдущих данных.

**Рекомендация:** настроить реальную отмену/timeout транспорта; учитывать активную операцию до её завершения. Перед генерацией синхронизировать нужные данные либо привязывать запрос к подтверждённой revision. Сделать модель конфигурируемой. Проверить корректное представление силовых подходов с нулевым весом: сейчас условие по truthiness веса превращает их в `undefined mins`.

### 22. P1 — Пустая дата рождения блокирует sync профиля; валидация HTTP неполна

Места: [schemas](/Users/tadatuta/projects/gym21/apps/server/src/http/routes/me.ts:6), [errors](/Users/tadatuta/projects/gym21/apps/server/src/http/errors.ts:23).

При сохранении личных параметров UI записывает `birthDateInput.value`, в том числе пустую строку, если дата рождения не заполнена. Сервер принимает её как `z.string()`, а `upsertProfile` передаёт через `profile.birthDate ?? null` в `$14::date`: пустая строка не превращается в null и не является допустимой SQL-датой. Обычное сохранение профиля без даты рождения поэтому создаёт ошибку всей sync-транзакции. [сохранение формы](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:1556), [SQL](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:592).

Также разрешены произвольный `status` тренировки, отрицательные/дробные повторения, свободные строки дат и IDs. Ошибки парсера JSON и превышения тела не обрабатываются отдельно и попадают в общий 500. Неподдерживаемый `protocolVersion` принимается как обычный запрос; клиент тоже не проверяет версию ответа.

**Рекомендация:** нормализовать необязательную пустую дату в отсутствие значения до записи в БД. Ввести один полный входной контракт с enum, диапазонами, датами, длинами, уникальностью IDs и фиксированным profile ID `me`; проверку protocol version; явные ответы 400/413/409 с безопасными кодами. Разрешить восстановление после ошибки одной записи без блокирования остальных. Обязательный regression test — сохранение профиля без даты рождения.

## Как упростить код и удалить лишнее

| Приоритет | Изменение | Зачем и где |
| --- | --- | --- |
| P2 | Разделить `main.ts` по пользовательским сценариям | В файле 2357 строк: bootstrap, auth, роуты, формы, статистика, AI, экспорт, DOM events. Выделить страницы тренировки/профиля/статистики/настроек и единый lifecycle mount/dispose. Оставить main точкой сборки. [main.ts](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:1) |
| P2 | Разделить локальные доменные операции и sync scheduling | `StorageService` объединяет CRUD, auth, миграции, кэши, импорт, очереди и UI callbacks в 1030 строках. Передавать account repository явно, выделить sync coordinator, backup service и read services. Сохранить общую транзакцию mutation+outbox. [storage.ts](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:80) |
| P2 | Выделить sync use case и SQL/read repositories на сервере | 1658 строк `storage.ts` объединяют DTO, импорт, SQL, sync, aliases, public cache и AI selection. Разделить по ответственности, не создавать абстракции для несуществующих backend-ов. Убрать повторяющиеся циклы sync только после регрессионных тестов. [storage.ts](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:1) |
| P2 | Общий пакет контрактов клиента и сервера | Сейчас сущности и wire DTO вручную повторяются в client types, server storage и route schemas. Уже различаются optional workoutId/profile и допустимые статусы. Общая runtime-схема и выводимые из неё типы уменьшат расхождения; DB row types оставить серверными. [types](/Users/tadatuta/projects/gym21/apps/client/src/types/index.ts:1), [server DTO](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:960) |
| P2 | Один индикатор sync и один способ подписки | В main два DOM-индикатора и два `onSyncStatusChange`; второй callback заменяет первый. В CSS две `.sync-status` с разными соглашениями имён. Удалить старую реализацию и держать состояние в одном месте. [первая подписка](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:270), [вторая](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:2248), [CSS](/Users/tadatuta/projects/gym21/apps/client/src/styles/components.css:271) |
| P2 | Освобождать обработчики компонентов | Каждый `bindTypeahead` добавляет `document.click` без удаления; замыкание удерживает старый wrapper и список items после render. `Sortable.create` тоже не сохраняется для destroy. Возвращать dispose или использовать AbortController для событий; хранить экземпляр Sortable. [Typeahead](/Users/tadatuta/projects/gym21/apps/client/src/components/typeahead/Typeahead.ts:270), [Sortable](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:1423) |
| P2 | Общий слой auth identity и транзакций | `auth.ts` — 1137 строк; управление aliases дублируется в `auth-meta.ts`. Чтения через глобальный pool внутри операций с PoolClient обходят транзакционный snapshot и усложняют конкуренцию. Передавать transaction client во все связанные операции, централизовать владение aliases и account linking. [auth.ts](/Users/tadatuta/projects/gym21/apps/server/src/auth.ts:294), [auth-meta.ts](/Users/tadatuta/projects/gym21/apps/server/src/auth-meta.ts:223) |
| P3 | Удалить доказуемо мёртвый код | Серверный tsc с unused-проверками находит `ArrayEntityType`, `defaultSyncChanges`, `workoutsChanged`. `chooseStorageKeyForUser` имеет одинаковые ветки ternary; `assertNoStorageConflictForTelegramLink` ничего не делает. `Storage` facade, ряд методов AuthMetaService и client helpers не имеют production-вызовов. Удалять после поиска внешних script consumers, не оставлять пустую «защиту». [storage.ts](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:13), [auth.ts](/Users/tadatuta/projects/gym21/apps/server/src/auth.ts:273) |
| P3 | Удалить неработающие compatibility-настройки | `autoInit` игнорируется, `RATE_LIMIT_STORAGE_*` не применяются. После фиксации версии sync сделать acknowledgements/protocol обязательными и убрать fallback «всё отправленное подтверждено». Legacy-миграции IndexedDB/localStorage удалить только после проверки, что они больше не нужны реальным пользователям. [options](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:57), [ack fallback](/Users/tadatuta/projects/gym21/apps/client/src/services/sync.ts:273) |
| P3 | Привести зависимости к фактическому использованию | Нет imports для client `zod`, `@types/w3c-image-capture`, server `rimraf`, прямых `kysely` / `@better-auth/kysely-adapter`. Первые — кандидаты на удаление или использование для валидации импорта; Kysely-зависимости проверить также как peer/transitive требования auth. `@types/sortablejs` и `vite-plugin-pwa` перенести в devDependencies. Не делать массовый upgrade без отдельного audit и проверки lockfile. [client package](/Users/tadatuta/projects/gym21/apps/client/package.json:15), [server package](/Users/tadatuta/projects/gym21/apps/server/package.json:17) |

## Производительность и эксплуатация

1. **P2 — Перестать читать всю IndexedDB после каждого изменения.** `reloadCache` вызывает `readAll` всех сущностей, затем UI заново фильтрует и сортирует историю. Использовать запросы по датам/IDs, локальное обновление изменённых записей и уведомления с составом изменений. Строить `Map` для lookup типов/сессий вместо повторяющихся `find` в циклах. Сначала устранить потерю черновиков, затем измерять на 10–100 тысячах logs. [reloadCache](/Users/tadatuta/projects/gym21/apps/client/src/storage/storage.ts:447), [история](/Users/tadatuta/projects/gym21/apps/client/src/main.ts:799).

2. **P2 — Сделать публичные и AI-чтения ограниченными.** Публичный профиль на cache miss выгружает всю историю, даже когда полная история скрыта. AI читает все workout types и ненужные генератору workouts; лимит типов применяется уже в памяти. Вычислять агрегаты SQL-запросами, ограничить историю и частоту публичного endpoint, добавить индексы под `(storage_key, logged_at)` / `(storage_key, start_time)` по результатам EXPLAIN. [public query](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:1578), [AI query](/Users/tadatuta/projects/gym21/apps/server/src/storage.ts:1530).

3. **P2 — Объединить управление SQL-схемой.** Storage использует файлы migrations, auth — большую строку `CREATE TABLE IF NOT EXISTS`, которая не обеспечивает эволюцию существующих таблиц. Migration runner не имеет межпроцессной блокировки: два стартующих экземпляра могут одновременно увидеть неприменённую migration. Перенести auth schema в тот же versioned runner и сериализовать применение migrations. Рассмотреть единый pool для общей БД и транзакций auth/storage. [database](/Users/tadatuta/projects/gym21/apps/server/src/database.ts:49), [auth schema](/Users/tadatuta/projects/gym21/apps/server/src/auth-meta.ts:17).

4. **P2 — Уменьшить Docker-контекст и production-образ.** `.dockerignore` отсутствует. `COPY apps/server apps/server` может перенести локальный `.env`, если он появится в этой директории. Финальный backend копирует весь `node_modules` обоих workspaces вместе с devDependencies, исходниками и тестами. Исключить секреты, локальные JSON, `.git`, node_modules и dist из build context; копировать только production dependencies, dist и migrations; запускать сервер от непривилегированного пользователя. [Dockerfile](/Users/tadatuta/projects/gym21/apps/server/Dockerfile:1).

5. **P2 — Разделить liveness и readiness, задать границы ожидания.** `/health` всегда возвращает `ok`, в compose нет readiness API. Настроить connect/query timeouts БД, readiness с доступностью БД и состоянием migrations, обработку ошибки listen и ограничение времени shutdown. In-memory rate limiter достаточен только для одного процесса; перед горизонтальным масштабированием нужен общий счётчик и общий учёт дорогих операций. [server](/Users/tadatuta/projects/gym21/apps/server/src/server.ts:24), [rate limit](/Users/tadatuta/projects/gym21/apps/server/src/http/middleware/rate-limit.ts:68).

6. **P2 — Не отключать проверку сертификата PostgreSQL.** Оба pool при `DATABASE_SSL=true` устанавливают `rejectUnauthorized: false`. Для удалённой БД использовать доверенную CA и проверку сертификата, а режим TLS сделать однозначным. [storage pool](/Users/tadatuta/projects/gym21/apps/server/src/database.ts:22), [auth pool](/Users/tadatuta/projects/gym21/apps/server/src/auth-meta.ts:112).

7. **P3 — Упростить CSS, доступность и защитные заголовки.** Общие стили форм из inline-шаблонов перенести в классы, устранить пересечения `.chart-container` / `.sync-status`. Убрать `user-scalable=no`, связать labels с input IDs, добавить доступные имена кнопок-иконок и клавиатурную семантику typeahead. Пересмотреть необходимость `unsafe-eval` и широкого `connect-src https:`; проверять CSP на реальном входе и аналитике, не расширять его ради исправления рендера. [index](/Users/tadatuta/projects/gym21/apps/client/index.html:6), [Login](/Users/tadatuta/projects/gym21/apps/client/src/components/auth/Login.ts:25).

8. **P3 — Привести документацию и локальные артефакты к одному состоянию.** `DATA_MIGRATION.md` содержит большой план, часть которого реализована, а часть расходится с кодом. Оставить короткую актуальную архитектуру и runbook, историю решений вынести в архив. Ссылку на отсутствующий `telegram-mock.ts` удалить или реализовать. `trash/`, `old-data-storage/` и `s.svg` не импортируются приложением; архивные пользовательские JSON вынести из checkout в контролируемый бэкап или исключить из Git и Docker. Удалять единственные копии данных нельзя.

## Что изменить в тестах

Корневая команда `npm test` запускает только сервер. Серверные HTTP-тесты содержат собственные `createMemoryStorageRepository` и `buildPublicProfile`, собственный auth resolver и stub AI. Поэтому тест может проверять правильную реализацию в fixture, пока production-реализация считает иначе — публичная статистика является конкретным примером. [root scripts](/Users/tadatuta/projects/gym21/package.json:13), [test doubles](/Users/tadatuta/projects/gym21/apps/server/test/app.test.js:11).

Рекомендуется:

- единая корневая команда проверок обоих workspaces и server lint/unused checks;
- CI на Node 22 с `npm ci`, typecheck, lint, tests и build;
- интеграционные тесты настоящего repository с изолированным PostgreSQL: пустой pull после изменений на втором устройстве, потеря ответа/retry, версии, deletion, aliases, cache invalidation и migrations;
- auth-тесты с настоящими endpoints: placeholder email, владение alias, конкурентная регистрация, link Telegram, выход при 503;
- несколько браузерных сценариев: offline startup→online, два аккаунта в двух вкладках, ввод во время sync, восстановление бэкапа, новая установка PWA и обновление service worker;
- одинаковые contract fixtures для клиента и сервера; не копировать доменную логику в mocks.

Автономные проверки аудита находятся в [audit/reproduce.mjs](/Users/tadatuta/projects/gym21/audit/reproduce.mjs) и [audit/reproduce-server.mjs](/Users/tadatuta/projects/gym21/audit/reproduce-server.mjs). Они намеренно утверждают наличие текущих дефектов, работают на синтетических данных и не подключаются к пользовательской БД. Перед запуском нужен build сервера. После исправлений их следует заменить нормальными regression tests с ожидаемым правильным поведением, а не добавлять как обязательную проверку наличия ошибок в CI.

## Рекомендуемый порядок работ

1. **Безопасность идентичности:** закрыть переназначение aliases и placeholder email; привязать сетевые операции к аккаунту. Добавить регрессионные проверки до рефакторинга auth.
2. **Сохранность данных:** исправить receipts для pull, reconnect, sign-out, семантику/валидацию импорта и порядок действий импортёра. Добавить тесты с настоящим PostgreSQL и несколькими клиентами.
3. **Корректный интерфейс:** сохранить черновики, исправить latest log, статистику, даты/длительности и экспорт; убрать дублирующий индикатор и утечки обработчиков.
4. **Упрощение:** общий контракт, разделение UI/storage/auth, удаление мёртвого кода и compatibility после проверки необходимости. Исправить dev scripts и Docker.
5. **Измеренная оптимизация:** ограниченные выборки и пачки sync, SQL-агрегации, индексы, размер образа и lazy loading тяжёлых клиентских функций по результатам измерений.

Стоит сохранить уже работающие решения: mutation и outbox в одной IndexedDB-транзакции, поколения outbox, сохранение конфликтующего локального payload, блокировку storage root в PostgreSQL, HttpOnly cookie-сессии и очистку Markdown через DOMPurify. Они решают реальные задачи; упрощение должно устранять дублирование и неявные состояния вокруг них.
