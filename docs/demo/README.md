# Public demo: приватная встреча на четыре человека

Открытый сценарий VRATA-FEAT-033 рассчитан на 15–20 минут после подготовки окружения. Ведущий и три приглашённых встречаются в отдельной `standard/private` комнате шаблона `meeting-room-basic@2.0.0`. Четыре ссылки дают роли host, member, member, guest; они не являются одноразовыми. Встреча использует сохраняемые общие заметки, трёхстраничный PDF, голос и обычные средства управления комнатой. Материалы и их происхождение: [`tools/fixtures/public-demo/LICENSES.md`](../../tools/fixtures/public-demo/LICENSES.md). Сцена уже закреплена шаблоном: `warm-modern-meeting-room-candidate-01@0.3.4` из `vrata-labs/warm-modern-meeting-room-candidate-01`, commit `a237ab799acbee3932846147c9f48bf1d1b4aaa8`; 3D-файлы не копируются в этот репозиторий.

## Контракт доступа

| Действие | host | member | guest |
|---|---:|---:|---:|
| Войти по своей ссылке, видеть поверхность и заметки, подключить голос | да | да | да |
| Редактировать shared notes | да | да | нет |
| Смотреть библиотеку документов | да | да | нет |
| Загрузить/запустить PDF, переключать страницы, остановить показ | да | нет | нет |
| Заблокировать вход, разблокировать, удалить участника | да | нет | нет |

Роли определяются сервером из приглашения, а не параметром `role` в URL. Гость не получает право менять общую заметку или управлять показом даже с `?role=host`. Пользователь не появляется в presence при создании ссылки: он появляется после настоящего входа. Шаблон содержит восемь мест; четыре человека — размер сценария, не предел комнаты. Выбор `debug-main` у документа записывает привязку; запуск PDF выполняет ведущий в интерфейсе.

## Локально из чистого clone

Нужны Node.js 22, pnpm 10 (`packageManager` в корневом `package.json`), Docker и Compose **2.24.4+**, доступ к публичным pinned scene assets (или byte-identical mirror). Порты 4000/tcp, 2567/tcp, 7880/tcp, 7881/tcp+udp и 9000/tcp должны быть свободны на `127.0.0.1`. Открывайте ссылки в браузере той же машины: профиль loopback-only не подходит для телефонов и четырёх физических устройств. Для них используйте подготовленный HTTPS staging/production self-host.

```bash
git clone https://github.com/vrata-labs/platform.git vrata-demo
cd vrata-demo
SHA="$(git rev-parse HEAD)"
node tools/public-demo-local-env.mjs --source-sha "$SHA"
pnpm install --frozen-lockfile
# pnpm may change the tracked mode of this workspace bin; in a fresh clone restore that mode only.
git diff --summary
git restore -- packages/asset-pipeline/bin/vrata.mjs
git diff --exit-code HEAD
node tools/public-demo-local-env.mjs --check
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml up -d --build
curl -fsS http://127.0.0.1:4000/health
```

Env создаётся один раз без перезаписи, с правами `0600`, отдельными случайными секретами и образом с полным SHA; генератор требует чистое рабочее дерево. Не используйте example env с `devkey/secret` или `LIVEKIT_URL` публичного staging. `--check` анализирует **rendered** Compose model без вывода секретов: опубликованные порты только loopback, API в production mode, dev-role query выключен, LiveKit без `--dev`, с согласованными ключами и TCP/UDP 7881. Система использует собственные Compose project/volumes. Перед активацией учитывайте: она делает три reference templates активными **во всём этом одноразовом локальном каталоге**.

MinIO и mc собираются в local overlay из официальных Linux release binaries с закреплёнными SHA-256 поверх pinned Alpine base: прежние публичные образы MinIO/mc в Quay/Docker Hub больше не доступны для нового pull. Оба внешних бинарника распространяются по GNU AGPLv3; репозиторий VRATA не включает их копии. Сборка ограничена `linux/amd64`; каталог и production/staging Compose остаются без изменений.

В этом профиле `MINIO_PUBLIC_BASE_URL=http://minio:9000` — адрес **внутри** Compose для серверного чтения PDF. Браузеры получают документы через авторизованные маршруты API; прямые MinIO URL из метаданных не используются как публичные ссылки для демонстрации.

```bash
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml exec -T api node apps/api/dist/template-catalog-cli.js status
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml exec -T api node apps/api/dist/template-catalog-cli.js preflight
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml exec -T -e VRATA_TEMPLATE_WAVE2_SHA="$SHA" api node apps/api/dist/template-catalog-cli.js activate --expected-image-sha "$SHA" --rollback-sha "$SHA"
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml exec -T api node apps/api/dist/template-catalog-cli.js status
export VRATA_ADMIN_TOKEN="$(node -e 'const fs=require("node:fs");const line=fs.readFileSync("infra/docker/.env.demo-local.local","utf8").split("\n").find(x=>x.startsWith("CONTROL_PLANE_ADMIN_TOKEN="));if(!line)process.exit(1);process.stdout.write(line.slice(line.indexOf("=")+1))')"
pnpm demo:public seed --base-url http://127.0.0.1:4000 --state-file .local/public-demo/local.json
pnpm demo:public check --state-file .local/public-demo/local.json
```

Статус до активации: `wave2`; после неё: `active`, три версии `2.0.0`. До активации `seed` выдаёт `demo_catalog_not_active`, а не создаёт legacy room. CLI сам проверяет `/health`, обязательные features, Postgres, конфигурацию LiveKit, admin session и exact current template. `check` означает только `prepared`, а **не** успешную встречу. На повторном `seed` готового run ничего не создаётся и не перезаписывается, включая редактированные заметки. После частичной ошибки повторная подготовка выдаёт `demo_seed_incomplete`: сначала `cleanup`, затем новый run.

Четыре секретные ссылки находятся **только** в приватном state-файле. Передавайте каждую адресату отдельно защищённым каналом; не прикладывайте файл, ссылки или URL с параметром `invite` к отчётам/CI. Для локального вывода только оператору:

```bash
node -e 'const s=require("node:fs").readFileSync(".local/public-demo/local.json","utf8");for(const [i,v] of JSON.parse(s).resources.invites.entries())process.stdout.write(`${i+1}. ${v.role}: ${v.inviteLink}\n`)'
```

После проверки persistence перезапустите только API (Postgres/MinIO остаются) и повторите `check`, затем обновите браузерную страницу, проверьте заметки и PDF:

```bash
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml restart api
pnpm demo:public check --state-file .local/public-demo/local.json
```

На чистом local профиле отдельно проверьте в двух браузерных сеансах реальный LiveKit media transport и двусторонний голос. Два работающих индикатора без слышимости — не успех. Synthetic microphone автотеста не заменяет двух реальных микрофонов для финальной приёмки.

## Staging

На HTTPS staging каталог уже должен быть `active`, с exact current `meeting-room-basic@2.0.0`. Команда не активирует общие staging templates и не меняет существующие комнаты. Дайте оператору `VRATA_ADMIN_TOKEN` через окружение (`STAGING_ADMIN_TOKEN` можно перенести в него внутри защищённой shell-сессии), используйте отдельный gitignored private state:

```bash
pnpm demo:public seed --base-url https://STAGING_APP_ORIGIN --state-file .local/public-demo/staging.json
pnpm demo:public check --state-file .local/public-demo/staging.json
```

Подставьте реально опубликованный HTTPS origin без пути. Для запуска всего staging gate **после deployment того же commit**: `pnpm test:e2e:staging`. Синтетический голос в автоматическом gate проверяет настоящий WebRTC/LiveKit transport; слышимость подтверждается людьми отдельно.

## Чек-лист встречи

Используйте четыре независимых browser sessions, host и два members + guest, обычные URL/onboarding и пользовательские controls; не добавляйте `onboard=0`, `role=host`, `audiomock`, `sharemock`. Зафиксируйте SHA, browser/OS/network и итог по каждому шагу в [шаблоне отчёта](report-template.md). Desktop Chromium обязателен; mobile/XR не наследуют его вердикт.

| Шаг | Что делает ведущий/участник | Ожидаемый результат | Если нет — проверить |
|---|---|---|---|
| D01 | Открыть room без invite; затем войти по четырём ссылкам через onboarding | Без invite отказ; четыре разных ID и у каждого ровно три remote | `invite_required`, private visibility, expiry/revoked, room-state connection, presence |
| D02 | Host и member говорят по очереди, mute/unmute | Речь слышна в обе стороны, mute останавливает передачу, unmute восстанавливает | mic permission, `audioState`, LiveKit media token/transport, speaker selector |
| D03 | Member меняет shared note, дожидается `Notes saved`; другой member обновляет страницу | Новый текст восстановлен; guest читает, но не редактирует | `notes-status`, `notes.saveState`, 403 на guest PUT, Postgres |
| D04 | Host выбирает загруженный PDF и нажимает Select for surface на `debug-main`, листает 1→2 | Страница 2 реально отрендерена у всех; guest не управляет | `renderState=ready`, page=2, surface texture, document checksum/linkedSurfaceId |
| D05 | Member перезагружается; guest выходит, исчезает, входит вновь; host листает 2→3 | Страница 2 и заметки восстановлены; затем у всех видна 3; нет пятого ghost ID | room-state connection/presence, PDF reload, отсутствие прежнего guest ID |
| D06 | Guest выходит, host блокирует вход; guest пробует тот же invite; host разблокирует | Во время lock `room_locked`; после unlock вход удаётся | host controls state, `room_locked` server response, trusted host role |
| D07 | Host удаляет guest | Guest отключён, у оставшихся по два remote; повторный вход соответствует штатной removal policy (invite не становится permanent ban) | `participant_removed`, session controls, presence |
| D08 | Host фиксирует решение, завершает показ и заполняет redacted report | Шаги D01–D07 с evidence и diagnosis; затем cleanup | `Notes saved`, `presentation-status`, cleanup record |

## Cleanup и восстановление после сбоя

```bash
pnpm demo:public cleanup --state-file .local/public-demo/local.json
# Если private state уже исчез после успешной очистки — безопасный повтор только по redacted record:
pnpm demo:public cleanup --state-file .local/public-demo/local.json.cleanup.json
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml exec -T api node apps/api/dist/template-catalog-cli.js rollback --expected-image-sha "$SHA"
docker compose --env-file infra/docker/.env.demo-local.local -f infra/docker/compose.selfhost.yml -f infra/docker/compose.demo-local.yml down
```

Для staging замените имя state-файла; **не** откатывайте общий каталог ради demo. `cleanup` сверяет origin/tenant/room ownership, отзывает invite, завершает session, удаляет документы вместе с media/blob, потом room и пустой tenant. При ошибке blob он оставляет приватный state и `.cleanup.json` (без секретов) для повтора; `demo_cleanup_incomplete` — не повод вручную удалять комнату. Если одноразовый локальный Compose project больше не нужен, `down -v` допустим **только** для его собственного project после успешного cleanup. Не используйте эту команду на общем staging.

## Диагностика CLI

CLI возвращает JSON со `step`, стабильным `error` и, если есть, HTTP status/requestId, без invite links и admin token. `demo_auth_failed`: проверить admin token и control-plane auth. `demo_feature_disabled`: проверить health/features/Postgres/LiveKit config. `demo_catalog_not_active`: status/activate exact template. `demo_state_conflict`: сверить origin, template, visibility и ownership, не исправлять чужую комнату. `demo_invites_unusable`: истёкшее/отозванное приглашение — cleanup и новый run. `demo_seed_incomplete`: очистить partial run. `demo_cleanup_incomplete`: сохранить record, повторить после исправления storage/media. Сообщайте redacted runId, SHA, step, status и requestId, но не URL с `invite`.
