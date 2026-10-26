# Staging: подготовка, поставка и восстановление

## Стенд и входы

Стенд создаётся по требованию и удаляется, когда не нужен (раздел «Стенд по требованию»).
Пока он есть, это Selectel `vrata-platform-stage`, Москва `ru-2c`, Ubuntu 24.04 LTS,
`SL1.4-8192-64` (4 vCPU / 8 ГБ / 64 ГБ local NVMe), сеть `vrata-platform-stage-net`,
группа безопасности `vrata-platform-stage` и плавающий IP `111.88.217.54`. Удалённый
сервер не оплачивается со следующего часа; плавающий IP остаётся за проектом.

Первый принятый application release подтверждается только успешным Staging Deploy
и `/opt/vrata-stage-state/accepted-release.json`. Подготовка Linux, pull образов и
UDP echo этого состояния не создают.

| Назначение | Адрес / путь |
| --- | --- |
| App | `https://111.88.217.54.sslip.io` |
| Room-state | `wss://state.111.88.217.54.sslip.io` |
| LiveKit | `wss://livekit.111.88.217.54.sslip.io` |
| Remote browser | `wss://browser.111.88.217.54.sslip.io` |
| Public objects (SeaweedFS, только GET/HEAD публичного bucket) | `https://storage.111.88.217.54.sslip.io` |
| Checkout | `/opt/vrata`, root-owned |
| Private env | `/opt/vrata/infra/docker/.env.staging`, 0600 |
| Release / assets / recovery | `/opt/vrata-stage-state`, вне checkout |

Сцены доставляются из приватного репозитория, не из публичных platform images.
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
6. Staging Deploy `bootstrap=true`, `activate_identity_v2=true` для последнего SHA `main`
   с успешным Docker Publish (или заданного `--sha`). Первый gate нового хоста на каталоге
   Wave 2 — только smoke (health, demo-room, control-plane, приватное хранилище плагинов);
   успешный gate записывает маркер Wave 2. Затем Staging Template Catalog `activate`
   на том же SHA включает эталонный каталог и прогоняет полный staging-набор. Только после зелёной активации `STAGING_AUTO_DEPLOY_ENABLED=true`: раньше автоматический деплой более нового SHA
   мог бы попасть на пустой хост, а bootstrap затем откатил бы его. SHA, опубликованный
   за время создания, `status` показывает в `server.behind`; его выкатывает следующий
   push или ручной Staging Deploy под арендой.

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
   `STAGING_ADMIN_TOKEN`, `PRIVATE_SCENE_ASSETS_HOST_DIR`.
   Приватный asset repository/key и YCR credentials остаются отдельными входами.
   Значения передавать через stdin/API защищённого операционного окружения.
4. Выполнить manual Staging Deploy: `deploy_sha=<full SHA>`, `bootstrap=true`.
   Ordinary/automatic запуск без принятого релиза завершается до rollout.
5. Проверить gate, media direct UDP / ICE TCP / TURN UDP, remote-browser и backup.
   Затем выполнить A/B проверку двумя разными совместимыми опубликованными SHA:
   B с `force_fail_gate=true` → восстановление A → обычный B → успешный gate.
6. После приёмки и local restore вернуть `STAGING_AUTO_DEPLOY_ENABLED=true`.

Deploy job сериализован группой `staging-deploy`; canary использует отдельную группу
`rutube-canary`. SHA приложения фиксирует asset SHA даже для неудачного кандидата.
Повтор использует binding, а не новую версию private `main`.

## Протокол релиза

Порядок: exact CI → host preflight → asset binding/snapshot → template prepare →
Compose pull/up → public HTTPS health → authenticated seed → единственный canonical
patch → staging gate → verify-wave2 → atomic accepted JSON → legacy marker →
Wave 2 baseline. Сервисы запускаются только из опубликованных SHA images. Rutube
проверяет отдельная задача после успешного деплоя; она не блокирует и не откатывает.

В gate входят только проверки, которым нужен реальный стенд: приватные сцены, реальные
LiveKit, медиа и хранилище, HTTPS, хранилище плагинов, миграции. Клиентская логика с
локальным двойником (песочница и бенчмарк плагинов, диалоги, фокус, ответы сервера,
подменённые в браузере) идёт только в локальном e2e. Самые тяжёлые многоклиентные
сценарии (два докладчика, native capture, публичное демо на четверых) помечены
`@staging-extended` и идут в Staging Extended (`.github/workflows/staging-extended.yml`):
вручную под арендой перед релизом или вокруг необратимой активации, по расписанию —
только пока стенд существует.

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
bindings не удаляются; исходные upload-копии можно получить повторно по pinned SHA.

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

## Backup и off-host копия

Во время backup исключить одновременную поставку и записи, которые должны попасть в
единую recovery point. `backup-staging.py` проверяет accepted record, working API
image и env до экспорта и повторно после. Релиз, принятый ещё на MinIO, экспортируется
с общим override pinned MinIO/MC; более новый — образами хранилища из своего Compose:

```bash
sudo python3 -B /opt/vrata/tools/backup-staging.py --root /opt/vrata \
  --output-dir /opt/vrata-stage-state/backups
```

SQL, inventory и объекты хранилища, image metadata и accepted JSON входят в checksum manifest.
Directories получают 0700, файлы 0600. Передать выбранную копию через SSH/tar в
gitignored `backups/beget-stage/` на рабочей машине и повторно валидировать:

```bash
node tools/backup-restore.mjs validate --backup-dir "$OFF_HOST_BACKUP"
node tools/backup-restore.mjs prune --output-dir backups/beget-stage --retention-days 14
```

Для удаления добавить `--confirm-prune`. Cleanup сохраняет минимум две более новые
checksum-verified копии; повреждённые/незавершённые копии не разрешают удаление старой.

## Изолированный local restore

1. Создать временный checkout точного accepted image SHA. Взять отдельный env,
   project name `vrata-restore`, loopback ports и новые локальные secrets.
   Не передавать staging env на существующий локальный Compose-проект.
2. Для релиза, принятого на MinIO, сформировать override pinned MinIO/MC тем же helper;
   foundation versions взять из accepted record. Релиз на SeaweedFS override не требует. Для application repos/tag использовать принятые YCR images.
3. Запустить отдельные PostgreSQL, хранилище и приложение; явный `COMPOSE_PROJECT_NAME`
   отделяет volumes. Не выполнять build и не использовать рабочие stage volumes.
4. Восстановить копию, передав оба Compose файла:

```bash
node tools/backup-restore.mjs restore --backup-dir "$OFF_HOST_BACKUP" \
  --env-file "$RESTORE_ENV" --compose-file infra/docker/compose.staging.yml \
  --compose-file "$RESTORE_OVERRIDE" --smoke-base-url "$RESTORE_URL" --confirm-restore
```

5. Сравнить room records, inventory объектов и SHA256 контрольного документа;
   скачать документ из локального восстановленного хранилища. Scene URLs из БД могут
   указывать на stage: для полностью локальной сцены нужны private assets по asset SHA.
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
