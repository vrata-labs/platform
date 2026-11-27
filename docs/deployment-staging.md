# Staging: подготовка, поставка и восстановление

## Стенд и входы

Стенд создаётся по требованию и удаляется, когда не нужен (раздел «Стенд по требованию»).
Пока он есть, это Selectel `vrata-platform-stage`, Москва `ru-2c`, Ubuntu 24.04 LTS,
`SL1.4-8192` (4 vCPU / 8 ГБ) с загрузочным сетевым томом `universal.ru-2c` 64 ГБ, сеть
`vrata-platform-stage-net`, группа безопасности `vrata-platform-stage` и плавающий IP
`111.88.217.54`. Удалённый сервер и его загрузочный том не оплачиваются со следующего часа;
плавающий IP остаётся за проектом. С 2026-10-29 стенд создаётся с сетевым томом:
Selectel пометил вариант с локальным NVMe (`SL1.4-8192-64`) недоступным в `ru-2c`.
Подсеть `vrata-platform-stage-net` раздаёт DNS `1.1.1.1, 8.8.8.8` в этом порядке: 2026-10-29
8.8.8.8 первым терял до 17 % запросов, и remote-browser не открывал внешние страницы за 15 с.

Первый принятый application release подтверждается только успешным Staging Deploy
и `/opt/vrata-stage-state/accepted-release.json`. Подготовка Linux, pull образов и
UDP echo этого состояния не создают.

| Назначение | Адрес / путь |
| --- | --- |
| App | `https://111.88.217.54.sslip.io` |
| Room-state | `wss://state.111.88.217.54.sslip.io` |
| LiveKit | `wss://livekit.111.88.217.54.sslip.io` |
| Remote browser | `wss://browser.111.88.217.54.sslip.io` |
| Public objects (SeaweedFS, только чтение объектов публичного bucket) | `https://storage.111.88.217.54.sslip.io` |
| Checkout | `/opt/vrata`, root-owned |
| Private env | `/opt/vrata/infra/docker/.env.staging`, 0600 |
| Release / assets / recovery | `/opt/vrata-stage-state`, вне checkout |

Сцены доставляются готовым закреплённым пакетом из приватного Selectel S3,
не из публичных platform images. Приватный GitVerse хранит восстановленный source
отдельно; deployment workflow не читает GitHub/GitVerse с приватными сценами.
Перенос сохраняет существующие GLB/manifest bytes и известные визуальные ограничения
сцен; новые visual acceptance или promotion-вердикты он не создаёт.

## Стенд по требованию

Стенд общий для CI, владельца и всех локальных сессий Claude Code и opencode. Создаёт и
удаляет его `tools/vrata-stage.py` на машине разработки: учётные данные Selectel есть только
там. Конфигурация стендов, ключи и кэш сертификатов лежат в приватном хранилище секретов
машины, вне Git. Правила для агентов — в `AGENTS.md`, раздел «On-demand staging stand».

```bash
vrata-stage acquire platform --purpose e2e --note "<задача>"   # аренда; создаёт отсутствующий стенд
vrata-stage wait platform                                       # готовность, возвращается за 9 минут
vrata-stage status                                              # фаза, аренды, операции
vrata-stage hold platform --ttl 4h                              # аренда владельца без сессии
vrata-stage release <lease>                                     # последняя аренда удаляет стенд после паузы
```

Аренда живёт до срока и, если её взяла сессия, пока жив процесс `claude` или `opencode`;
срок не больше суток. Сессии opencode живут в одном процессе сервера, поэтому для них
работает только срок.

Создание (`up`, фоновый процесс с журналом рядом с реестром аренд):

1. Сервер с тегом `vrata-stage=platform` и cloud-init из `infra/staging/on-demand-hook.sh`
   с `origin/main`: пользователь `vrata` с ключами администратора и CI. Секретов в
   user-data нет.
2. Плавающий IP привязывается к порту сервера. Занятый чужим портом IP останавливает
   создание до любых изменений.
3. Первый ключ хоста принимается только из журнала консоли провайдера, после чего на хост
   ставятся закреплённые ключи. `STAGING_SSH_KNOWN_HOSTS` не меняется между пересозданиями.
4. `bootstrap-host.sh`, затем токен администратора из хранилища вместо случайного:
   он совпадает с секретом `STAGING_ADMIN_TOKEN`.
5. Восстанавливается том данных Caddy: сертификаты переживают сервер, и частые
   пересоздания не упираются в лимит Let's Encrypt (5 сертификатов на имя за 7 дней).
6. Staging Deploy `bootstrap=true`, `activate_identity_v2=true`, `activate_media_codec3=true` для последнего SHA `main`
   с успешным Docker Publish (или заданного `--sha`). Первый gate нового хоста на каталоге
   Wave 2 — только smoke (health, demo-room, control-plane, приватное хранилище плагинов);
   успешный gate записывает маркер Wave 2. Затем Staging Template Catalog `activate`
   на том же SHA включает эталонный каталог и прогоняет полный staging-набор. Только после зелёной активации `STAGING_AUTO_DEPLOY_ENABLED=true`: раньше автоматический деплой более нового SHA
   мог бы попасть на пустой хост, а bootstrap затем откатил бы его. SHA, опубликованный
   за время создания, `status` показывает в `server.behind`; его выкатывает следующий
   push или ручной Staging Deploy под арендой.

До первого `acquire` S3-aware workflow, helper и release lock должны попасть в
default `main` через обычный PR, а exact candidate — пройти CI и Docker Publish.
Наличие этих файлов только в feature-ветке недостаточно: bootstrap запускается
из `main`. Также нужны опубликованный pinned пакет и положительный reader fetch;
одни отрицательные отказы S3 или локальная упаковка этого не подтверждают.

Удаление: нет живых аренд → нет активных прогонов Docker Publish, Staging Deploy,
Rutube Canary, Staging Template Catalog, Staging Smoke и любых других workflow, кроме CI,
Docker Release и Seat marker checks (разовые диагностики тоже ходят на стенд) → `STAGING_AUTO_DEPLOY_ENABLED=false` →
повторная проверка прогонов (начавшийся прогон возвращает переменную и оставляет стенд) →
сохранение тома Caddy → удаление сервера по ID и тегу. После `release` уборка ждёт паузу
и повторяет попытку, пока CI занят. Без стенда push в `main` не выкатывается и не
проверяется на staging: это происходит при следующем создании стенда.

Ошибка создания оставляет сервер для разбора, пока жива аренда; следующий `acquire`
повторяет создание с нуля. Данные стенда (комнаты, документы, принятые релизы) не
переносятся между пересозданиями.

## Подготовка Linux

На выделенном Linux-хосте запустить опубликованный bootstrap от root:

```bash
bash bootstrap-host.sh --public-ip "$STAGING_IP" --ssh-public-key "$PUBLIC_KEY_FILE"
```

Скрипт устанавливает Docker/Compose, Python и Node 22, готовит пользователя `vrata`,
sudo, публичный checkout и генерирует приватный env/designation. Для отдельно
загруженного набора helpers предусмотрен `--helpers-dir`. Повтор сохраняет env,
секреты и volumes; другое значение IP отклоняется. Сборка приложения не выполняется.

Открыты 22/80/443 TCP, ICE TCP 7881, ICE UDP mux 7882, TURN UDP 3478 и relay UDP
50000–50100. Внутренние административные порты в Compose привязаны к loopback;
Docker bindings проверяются отдельно от ufw. TURN/TLS не объявляется и не публикуется.

## Переключение CI/CD

1. Установить repo variable `STAGING_AUTO_DEPLOY_ENABLED=false` перед слиянием.
   Флаг приостанавливает только automatic deploy и scheduled canary; manual остаётся.
2. Поставить workflow в default `main` через PR и обязательные checks/review.
   Дождаться CI и Docker Publish именно merge SHA.
3. Завершить/отменить прежние queued deploy/canary. Переключить согласованный набор
   secrets целиком: `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_KEY`,
   `STAGING_SSH_KNOWN_HOSTS`, `STAGING_APP_DIR`, `STAGING_BASE_URL`,
   `STAGING_ADMIN_TOKEN`; YCR credentials остаются отдельными входами.
   Для S3 задать repository variables `VRATA_SCENES_S3_ENDPOINT`,
   `VRATA_SCENES_S3_REGION`, `VRATA_SCENES_S3_BUCKET` и reader secrets
   `PRIVATE_SCENES_S3_READER_ACCESS_KEY_ID`, `PRIVATE_SCENES_S3_READER_SECRET_ACCESS_KEY`.
   Private Git repository/deploy key/host-dir больше не являются входами деплоя.
   Значения передавать через stdin/API защищённого операционного окружения.
4. Выполнить manual Staging Deploy: `deploy_sha=<full SHA>`, `bootstrap=true`.
   Ordinary/automatic запуск без принятого релиза завершается до rollout.
5. Проверить gate, media direct UDP / ICE TCP / TURN UDP, remote-browser и backup.
   Затем выполнить A/B проверку двумя разными совместимыми опубликованными SHA:
   B с `force_fail_gate=true` → восстановление A → обычный B → успешный gate.
6. После приёмки и local restore вернуть `STAGING_AUTO_DEPLOY_ENABLED=true`.

Deploy job сериализован группой `staging-deploy`; canary использует отдельную группу
`rutube-canary`. SHA приложения фиксирует asset SHA даже для неудачного кандидата.
Повтор использует binding, а не новую версию private `main` или новый lock.

## Доставка приватного S3 release

Конфигурация по умолчанию: endpoint `https://s3.ru-3.storage.selcloud.ru`, region
`ru-3`, bucket `vrata-private-scene-releases`. Зона сервера не определяет S3-пул.
Используются стандартный S3 API и изолированный AWS CLI `1.46.0` с `certifi`
`2026.10.23`, а не API панели. Закреплённый набор доверенных корневых сертификатов
нужен для действующей цепочки GlobalSign у Selectel; проверка TLS остаётся включённой.
Reader имеет только GET в `private-scenes/releases/*`; отдельный writer —
GET/PUT без DELETE/list. Секреты writer в workflow не передаются. Настройка
внешнего release bucket не меняет Compose SeaweedFS, `MINIO_*` или plugin storage.

Порядок до изменения приложения:

1. Сохранить rollback helpers, fetch helper и `staging-scene-catalog.json`
   версии workflow в `RUNNER_TEMP` **до** checkout целевого deploy SHA.
   Fetch helper/catalog остаются только на runner, вне архива host helpers.
2. Read-only preflight bootstrap-installed helper проверяет designation/accepted
   state до отправки нового протокола/source. Второй preflight тем же протоколом
   возвращает прежний image binding; catalog-state читается из принятой БД.
3. После checkout target: если binding существует, fetch использует только его
   `--asset-sha`. Если binding отсутствует, обязателен строгий
   `infra/docker/private-scene-release.lock.json` **целевого** checkout.
   Сохранённая копия helper не приносит с собой новый lock.
4. Fetch получает reader secrets только через env этого шага, использует
   `--catalog` сохранённой версии, `--addressing-style path` и timeout 300.
   Проверяет descriptor, archive/inventory SHA-256 и размеры, безопасно
   распаковывает и проверяет весь source и 13 обязательных сцен.
5. Только полностью проверенный каталог появляется атомарно в
   `RUNNER_TEMP/private-scene-source`. Его `assets/` передаётся по SSH в
   `source/<imageSha>/<assetSha>` вне checkout и затем в
   `staging-remote-release.py --source`. S3 credentials хосту не нужны.

Сохранённый binding имеет приоритет и при историческом target без helper/lock.
Descriptor находится по `private-scenes/releases/<assetSha>/release.json`;
его отсутствие не разрешает использовать новый пакет с другой identity.
`assetSha` — 40 hex Git SHA исходников сцен; archive digest — отдельный SHA-256.
Наличие lock не означает, что release опубликован и доступен reader.
Команды выпуска и локальной проверки: [приватные сцены](scene-assets-repository.md).

`private_scene_release` возвращает ненулевой статус при AccessDenied/403/404,
тайм-ауте, ошибке размера/хеша, опасном архиве или неполном inventory.
Нет fallback на Git, `latest` или похожую версию. До rollout такой отказ
оставляет прежние images, accepted JSON, active и room URLs неизменными.
Браузер продолжает читать прежние app/state scene routes, не S3 и не presigned URL.

## Протокол релиза

Порядок: exact CI → host preflight → asset binding/snapshot → template prepare →
Compose pull/up → public HTTPS health → authenticated seed → единственный canonical
patch → staging gate → verify-wave2 → atomic accepted JSON → legacy marker →
Wave 2 baseline. Сервисы запускаются только из опубликованных SHA images. Rutube
проверяет отдельная задача после успешного деплоя; она не блокирует и не откатывает.

В gate входят только проверки, которым нужен реальный стенд: приватные сцены, реальные
LiveKit, медиа и хранилище, HTTPS, приватное хранилище плагинов и документов
(`document-storage-move.js --verify`), миграции. После публикации accepted release
шаг «Move room documents to private storage» переносит документы, оставшиеся в
публичном бакете от прежних релизов (`--confirm`); его отказ делает запуск красным
отдельным шагом в конце job и не откатывает принятый релиз. Клиентская логика с
локальным двойником (песочница и бенчмарк плагинов, диалоги, фокус, ответы сервера,
подменённые в браузере) идёт только в локальном e2e. Самые тяжёлые многоклиентные
сценарии (два докладчика, native capture, публичное демо на четверых) помечены
`@staging-extended` и идут в Staging Extended (`.github/workflows/staging-extended.yml`):
вручную под арендой перед релизом или вокруг необратимой активации, по расписанию —
только пока стенд существует.

### Приёмка публичного HTTPS в общем браузере

Запускать под арендой платформы на SHA из `accepted-release.json`. На стенде
должны быть включены обычный браузер и профиль `public-https-network`,
задан `REMOTE_BROWSER_PUBLIC_HTTPS_ENABLED=true`, настроен доступ издателя к
LiveKit и заполнен `REMOTE_BROWSER_PUBLIC_HTTPS_DENY_CIDRS` с учётом всех
внутренних маршрутов и собственных публичных адресов развёртывания.

- На подконтрольном публичном HTTPS-origin вне действующего списка разместить
  `tests/e2e/m1-media/remote-browser-control.html` без изменения содержимого.
  Страница меняет красный и синий кадры и воспроизводит тон 880 Гц без сторонних
  ресурсов. Нужен также подконтрольный рабочий HTTPS-адрес, уже входящий в
  действующий список. У обоих адресов должен быть действительный сертификат;
  указать их в `STAGING_REMOTE_BROWSER_PUBLIC_URL` и
  `STAGING_REMOTE_BROWSER_ALLOWLIST_URL` без секретов и параметров.
- `STAGING_REMOTE_BROWSER_TENANT`, `STAGING_REMOTE_BROWSER_ROOM` и
  `STAGING_REMOTE_BROWSER_NEIGHBOUR` задают организацию и две выделенные
  управляемые приватные комнаты с опубликованными сценами, доступной
  медиаповерхностью, действующим ведущим и исходным правилом `allowlist`.
  На время проверки эти комнаты не должны использоваться кем-либо ещё.
  Сценарий использует `getRoom` и `updateRoomAccess` в этой организации.
  `STAGING_REMOTE_BROWSER_OPERATOR_KID` и
  `STAGING_REMOTE_BROWSER_OPERATOR_KEY_FILE` указывают на разрешённый
  staging-ключ Ed25519; ключ хранится локально в защищённом файле.
- Нужны три выданные через `issueGrant` короткоживущие одноразовые ссылки:
  `STAGING_REMOTE_BROWSER_HOST_ENTRY_URL` и `STAGING_REMOTE_BROWSER_VIEWER_ENTRY_URL`
  для разных учётных записей выбранной комнаты, `STAGING_REMOTE_BROWSER_NEIGHBOUR_ENTRY_URL`
  для ведущего соседней. Передавать ссылки как секреты в локальном окружении.
  По текущему контракту обычная импортированная управляемая сцена создаётся как
  персональная комната: допускается только владелец, и его повторный вход
  сохраняет тот же ID участника. Если для выделенной комнаты второго
  участника нельзя допустить штатно, критерий остаётся открытым; два окна
  одного владельца не подтверждают этот сценарий.

На машине, где подготовлены локальные сборка и окружение staging:

```bash
STAGING_REMOTE_BROWSER_E2E=1 pnpm test:e2e:staging-extended -- tests/e2e/m1-media/remote-browser-public-https-staging.spec.ts
```

Тест включает правило через операторский API, читает декодированные кадры и
контрольный тон у второго участника, проверяет соседнюю комнату, выключенный
браузер, отзыв и возврат к списку. При выходе он восстанавливает настройки
изменённых комнат и закрывает браузерные сеансы. Ссылки сгорают при использовании
или истечении срока. Сценарий не вызывает `revokeGrant`: этот маршрут отзывает
все пропуска той же учётной записи в комнате и её активную личность.
После прерванного запуска сверить настройки через операторский API. Трассировка, видео и скриншоты для
этого сценария отключены, чтобы не записывать пропуска и приватные адреса сцены.

### Бюджет проверки и подтверждение релиза

Общий бюджет verification gate — 50 минут, job — 200 минут с запасом на rollback.
Это суммарный бюджет всего последовательного набора, а не
разрешённая задержка пользовательского действия: лимиты отдельных сценариев не
увеличиваются. При расширении каталога бюджет сверяется с фактическим полным прогоном
и оставляет время на запись отчёта. Истечение внешнего deadline до финального отчёта
не считается зелёной проверкой даже при успешных отдельных сценариях.

Authoritative JSON содержит image SHA, asset SHA, snapshot ID, foundation digests и
run ID/attempt. `.staging-successful-image-tag` — производный файл совместимости.
`IMAGE_TAG` в env может быть кандидатом и не является доказательством прохождения gate.

Снимки находятся в `snapshots/<imageSha>-<assetSha>/public`; Caddy читает `active`
через mount всей state directory. После принятия cleanup оставляет current, previous
и Wave 2 baseline. Referenced versioned URLs сохраняются в текущем дереве. Кандидатные
bindings не удаляются; исходные upload-копии можно получить повторно только из
точного S3 release с проверкой bytes. Полные исторические snapshots сохраняются
также в stage-specific backup.

## Ошибка и восстановление

До публикации accepted JSON автоматический rollback возвращает предыдущие checkout,
images, полный scene snapshot и pre-rollout room URLs. Volumes PostgreSQL и хранилища
сохраняются. Без previous release bootstrap оставляет диагностику и данные для повтора.

После публикации JSON ошибка legacy/baseline — repair, не откат контейнеров.
Следующий ordinary deploy блокируется до завершения финализации:

```bash
sudo python3 -B "$HELPERS/staging-accepted-release.py" repair-legacy --root /opt/vrata
sudo python3 -B "$HELPERS/staging-template-catalog.py" record-wave2 --root /opt/vrata --sha "$ACCEPTED_SHA"
```

`HELPERS` — сохранённый каталог `helpers/<workflow SHA>` соответствующей попытки.
Сначала прочитать authoritative record и фактическое состояние; не создавать
синтетический gate proof. Ошибка fsync после atomic rename тоже требует прочитать
committed state: она не доказывает, что публикация не состоялась.

Ручная отмена workflow не считается успешным rollback. Удалённые mutating operations
сериализуются host lock; recovery ждёт завершения уже запущенного rollout:

```bash
sudo python3 -B "$HELPERS/staging-remote-release.py" rollback --root /opt/vrata \
  --image-sha "$FAILED_SHA" --run-id "$RUN_ID" --run-attempt "$RUN_ATTEMPT"
```

Приватный снимок URL сохраняется в `attempts/<runId>-<attempt>/scene-urls.json`.
Перенести его по SSH в приватный локальный файл и восстановить существующим helper:

```bash
BASE_URL="$STAGING_BASE_URL" STAGING_ADMIN_TOKEN="${STAGING_ADMIN_TOKEN:?Export the current admin token}" \
  node tools/staging-scene-snapshot.mjs restore "$PRIVATE_POINTER_SNAPSHOT"
```

После readback всех URL выполнить `/health`, `demo-room`, `control-plane` и staging e2e.
Rollback требует доступных YCR images; удаление volumes в этот путь не входит.
Уже сохранённый предыдущий snapshot не требует нового скачивания из S3.
Если его нужно восстанавливать, допустим только точный pinned release или
проверенные backup bytes. Неизвестный binding/пропавшая история блокируют откат,
а не заменяются новым `assetSha`. Возвращать обязательный private Git checkout
как способ отката поставки нельзя.

## Backup и off-host копия

Во время backup исключить одновременную поставку и записи, которые должны попасть в
единую recovery point. `backup-staging.py` удерживает сначала host operation lock,
затем shared accepted-state lock на весь экспорт и проверяет accepted record,
working API image и env до экспорта и повторно после. Релиз, принятый ещё на MinIO, экспортируется
с общим override pinned MinIO/MC; более новый — образами хранилища из своего Compose:

```bash
sudo python3 -B /opt/vrata/tools/backup-staging.py --root /opt/vrata \
  --output-dir /opt/vrata-stage-state/backups
```

SQL, inventory и объекты хранилища, image metadata и accepted JSON входят в checksum manifest.
Дополнительно `private-scenes/recovery.json` format 1 (`included-snapshots`)
фиксирует current/previous accepted records, Wave 2, требуемые image/asset bindings,
derived S3 descriptor keys и room URLs из **этого же** SQL-дампа, включая
`template_snapshot.roomConfig.sceneBundleUrl`. Рядом сохраняются полные проверенные
`snapshot.json` и public trees current/previous/Wave 2. Versioned URLs, чей отдельный
snapshot уже удалён retention, проверяются по binding/marker и сохраняются внутри
текущего public tree. Derived descriptor key — locator, не доказательство
наличия descriptor в S3. Включённые snapshots не требуют S3 credentials на хосте.

Все scene files входят в существующий checksum manifest как artifacts
`kind: private-scene-recovery`; общая схема backup не меняется. Потерянные bytes,
неизвестный binding, несогласованный active или смена acceptance дают отказ.
Экспорт сначала находится в `.incomplete-vrata-*`, вне retention. Только итоговая
проверка разрешает atomic rename в `vrata-*`; при ошибке manifest помечается
incomplete, частичные scene copies убираются, принятый релиз не меняется.

Directories получают 0700, файлы 0600. Передать выбранную копию через SSH/tar в
gitignored `backups/beget-stage/` на рабочей машине и повторно валидировать:

```bash
node tools/backup-restore.mjs validate --backup-dir "$OFF_HOST_BACKUP"
python3 -B tools/private-scene-recovery.py validate --backup-dir "$OFF_HOST_BACKUP"
node tools/backup-restore.mjs prune --output-dir backups/beget-stage --retention-days 14
```

Для удаления добавить `--confirm-prune`. Cleanup сохраняет минимум две более новые
checksum-verified копии; повреждённые/незавершённые копии не разрешают удаление старой.
Для scene recovery общей checksum-валидации недостаточно: companion проверяет
точный набор snapshots, bindings, URL-версии и inventory. Старый metadata-only
backup остаётся полезным для SQL/объектов, но не объявляется полным backup сцен.

### Восстановление только байтов сцен

В platform checkout с согласованным набором tools, Node и Python:

```bash
python3 -B tools/private-scene-recovery.py restore \
  --backup-dir "$OFF_HOST_BACKUP" --output "$RECOVERED_SCENES"
```

Родитель output должен существовать, сам output — отсутствовать или быть пустым
и находиться вне backup. Helper блокирует публикацию через parent-directory lock,
проверяет исходный backup и скопированные bytes, повторно проверяет backup и
публикует результат атомарным rename. Ошибка/порча/изменение backup не оставляют
частичного результата и не заменяют существующий непустой каталог.

Результат содержит **только** `recovery.json` и `snapshots/`. Это byte recovery,
не AcceptedState: helper не устанавливает accepted-release, designation, gate proof
или active. Не копировать старый accepted JSON как authority нового хоста.
Новый live-хост по-прежнему требует реального designation, штатной поставки,
gate и acceptance. Recovery points и scene trees остаются приватными.

## Изолированный local restore

1. Создать временный checkout точного accepted image SHA. Взять отдельный env,
   project name `vrata-restore`, loopback ports и новые локальные secrets.
   Не передавать staging env на существующий локальный Compose-проект.
2. Для релиза, принятого на MinIO, сформировать override pinned MinIO/MC тем же helper;
   foundation versions взять из accepted record. Релиз на SeaweedFS override не требует. Для application repos/tag использовать принятые YCR images.
3. Запустить отдельные PostgreSQL, хранилище и приложение; явный `COMPOSE_PROJECT_NAME`
   отделяет volumes. Не выполнять build и не использовать рабочие stage volumes.
4. Восстановить копию. Для релиза на SeaweedFS `--compose-file "$RESTORE_OVERRIDE"` не передаётся:

```bash
node tools/backup-restore.mjs restore --backup-dir "$OFF_HOST_BACKUP" \
  --env-file "$RESTORE_ENV" --compose-file infra/docker/compose.staging.yml \
  --compose-file "$RESTORE_OVERRIDE" --smoke-base-url "$RESTORE_URL" --confirm-restore
```

5. Сравнить room records, inventory объектов и SHA256 контрольного документа;
   скачать документ из локального восстановленного хранилища. Scene URLs из БД могут
   указывать на stage: для полностью локальной сцены восстановить точные bytes
   companion helper выше либо fetch pinned S3 release по сохранённому asset binding.
   Новый пакет не восстанавливает прежние room URL версии автоматически.
6. Сохранить restore evidence и удалить только временный restore project после проверки.

## Проверки и запись результатов

```bash
pnpm staging:e2e:pull-env -- --ssh "vrata@$STAGING_IP"
pnpm test:e2e:staging
pnpm test:e2e:rutube
pnpm test:e2e:rutube:canary
```

Команды используют `.env.staging.local` либо explicit env, без старого IP fallback.
Хранить image/asset SHA, CI/Publish/Deploy/canary URLs, gate results, A/B recovery и
backup/local restore evidence. Локальный green, наличие image или состояние `loaded`
сами по себе не подтверждают media или визуальную приёмку.

После bootstrap/активации дополнить приватный реестр восстановления фактическими
current/previous/Wave 2 и версиями из room URLs: image binding, descriptor key,
archive/inventory SHA-256, результат S3 fetch или snapshot restore. Проверка одного
локального пакета не доказывает полноту истории нового хоста. Реестр и результаты
с персональными данными/scene bytes не публиковать в общих CI artifacts.
