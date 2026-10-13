# Staging: подготовка, поставка и восстановление

## Стенд и входы

Подготовленный целевой хост — Selectel `vrata-stage-selectel-v1`, `135.106.137.18`,
Москва `ru-2c`, Ubuntu 24.04 LTS, 4 vCPU / 8 ГБ / 80 ГБ local NVMe.
Расчёт при создании: 6272,37 ₽/месяц вместе с прямым IPv4. Резервное хранение
оплачивается отдельно, если подключается платная услуга.

Первый принятый application release подтверждается только успешным Staging Deploy
и `/opt/vrata-stage-state/accepted-release.json`. Подготовка Linux, pull образов и
UDP echo этого состояния не создают. Старые ресурсы Yandex сохраняются.

| Назначение | Адрес / путь |
| --- | --- |
| App | `https://135.106.137.18.sslip.io` |
| Room-state | `wss://state.135.106.137.18.sslip.io` |
| LiveKit | `wss://livekit.135.106.137.18.sslip.io` |
| Remote browser | `wss://browser.135.106.137.18.sslip.io` |
| MinIO public objects | `https://storage.135.106.137.18.sslip.io` |
| Checkout | `/opt/vrata`, root-owned |
| Private env | `/opt/vrata/infra/docker/.env.staging`, 0600 |
| Release / assets / recovery | `/opt/vrata-stage-state`, вне checkout |

Сцены доставляются из приватного репозитория, не из публичных platform images.
Перенос сохраняет существующие GLB/manifest bytes и известные визуальные ограничения
сцен; новые visual acceptance или promotion-вердикты он не создаёт.

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
patch → staging/Rutube gate → verify-wave2 → atomic accepted JSON → legacy marker →
Wave 2 baseline. Сервисы запускаются только из опубликованных SHA images.

Authoritative JSON содержит image SHA, asset SHA, snapshot ID, foundation digests и
run ID/attempt. `.staging-successful-image-tag` — производный файл совместимости.
`IMAGE_TAG` в env может быть кандидатом и не является доказательством прохождения gate.

Снимки находятся в `snapshots/<imageSha>-<assetSha>/public`; Caddy читает `active`
через mount всей state directory. После принятия cleanup оставляет current, previous
и Wave 2 baseline. Referenced versioned URLs сохраняются в текущем дереве. Кандидатные
bindings не удаляются; исходные upload-копии можно получить повторно по pinned SHA.

## Ошибка и восстановление

До публикации accepted JSON автоматический rollback возвращает предыдущие checkout,
images, полный scene snapshot и pre-rollout room URLs. PostgreSQL/MinIO volumes
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
image и env до экспорта и повторно после; использует общий источник pinned MinIO/MC:

```bash
sudo python3 -B /opt/vrata/tools/backup-staging.py --root /opt/vrata \
  --output-dir /opt/vrata-stage-state/backups
```

SQL, MinIO inventory/objects, image metadata и accepted JSON входят в checksum manifest.
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
2. Сформировать override pinned MinIO/MC тем же helper; foundation versions взять
   из accepted record. Для application repos/tag использовать принятые YCR images.
3. Запустить отдельные PostgreSQL/MinIO и приложение; явный `COMPOSE_PROJECT_NAME`
   отделяет volumes. Не выполнять build и не использовать рабочие stage volumes.
4. Восстановить копию, передав оба Compose файла:

```bash
node tools/backup-restore.mjs restore --backup-dir "$OFF_HOST_BACKUP" \
  --env-file "$RESTORE_ENV" --compose-file infra/docker/compose.staging.yml \
  --compose-file "$RESTORE_OVERRIDE" --smoke-base-url "$RESTORE_URL" --confirm-restore
```

5. Сравнить room records, MinIO object inventory и SHA256 контрольного документа;
   скачать документ из локального восстановленного MinIO. Scene URLs из БД могут
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
