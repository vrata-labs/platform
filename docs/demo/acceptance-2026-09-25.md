# VRATA-FEAT-033 — redacted acceptance record

Статус: **REWORK_REQUIRED до повторной ручной проверки голоса**. При первом испытании реальными устройствами D02 не прошёл; UI исправлен и автоматический gate повторно прошёл, но слышимость двух реальных микрофонов не подтверждена. Этот отчёт не является `demo_passed` и не закрывает AC-033-01/03/04/10 без независимого разработчика и четырёх участников.

## Опубликованная версия

- Ветка: `feat/public-demo-scenario`.
- Проверенный и развёрнутый код: `7cf806deb277b3d9b4c4744c03bb7c32c69e53a3`; предыдущая версия `ded3b2791d3d1dc7a6472be7925342e66ed0f5ca` оставила аудиокнопку с неочевидным muted-состоянием.
- Шаблон: `meeting-room-basic@2.0.0`, сцена: `warm-modern-meeting-room-candidate-01@0.3.4` (pinned repository commit `a237ab799acbee3932846147c9f48bf1d1b4aaa8`).
- Staging: `https://158.160.10.234.sslip.io`, public smoke `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — HTTP 200. Каталог: три active/current reference templates версии `2.0.0`.

## Автоматические доказательства

| Проверка | Результат |
|---|---|
| Local Node 22 lint, typecheck, build, package tests | Пройдены; runtime: 834/834, tools: 112/112, API: 778 passed, 1 existing skipped. |
| Full local `pnpm test:e2e` на финальном runtime-дереве | **148/148**. Новая проверка Enter without audio → Join Audio Muted → снятие Join muted; изолированный Postgres fixture: seed → read-only check → API restart → PDF/notes persistence → cleanup. |
| Source-build из нового clone `ded3b279...` | Авторский прогон инфраструктурного рецепта до UI-коррекции: generated env 0600, rendered Compose validation, fresh project/volumes, Wave 2 → active, seed/check, PDF checksum и чтение после API restart, полный четырёхконтекстный browser scenario с реальным локальным LiveKit transport, cleanup и повтор по redacted record, rollback каталога в Wave 2, `down -v` только disposable project. **Независимый разработчик ещё не повторил рецепт.** |
| [CI run 36112723532](https://github.com/vrata-labs/platform/actions/runs/36112723532) | Success на `7cf806d...`: lint, typecheck, build, package tests, full E2E, M0.5 acceptance и pinned asset validation. |
| [Docker Publish run 36112723330](https://github.com/vrata-labs/platform/actions/runs/36112723330) | Success: immutable SHA tags API/room-state/remote-browser и проверенные manifest digests вспомогательных MinIO/mc. |
| [Staging Deploy run 36114986345](https://github.com/vrata-labs/platform/actions/runs/36114986345) | Success: rollout SHA, **48/48 staging E2E**, blocking Rutube **1/1**, persisted successful SHA. Hall, BlueOffice, ArtGallery: `loaded` на текущей странице; автоматический demo-сценарий прошёл muted → Unmute → media publish/subscribe. |

В artifact `playwright-staging-gate-36114986345-1` приложен **public-demo-cleanup-record**: `completed`, invites revoked, document deleted, session ended, room и tenant deleted. Ручная комната runId `d553e464-30a1-4ac9-bef1-35b36375a188` остаётся `prepared` для повторной проверки; это **другой** run, его не удаляли. Секретные invite links и admin token в отчёт не включены.

Автоматический D02 использовал synthetic capture source и **настоящий** LiveKit/WebRTC transport с проверкой publish/subscribe, received bytes, spatial node, mute/unmute. Он не доказывает слышимость двух реальных микрофонов.

## Ручная приёмка

| Гейт | Состояние |
|---|---|
| Независимый разработчик повторил чистый clone и recipe (AC-033-01) | not-run: нужен второй разработчик. |
| D01–D08 одновременно с четырьмя людьми на staging (AC-033-03/07) | not-run: нужны четыре участника и обычные браузерные сессии. |
| Двусторонняя слышимость двух реальных микрофонов и mute/unmute (AC-033-04) | **fail** на `ded3b279...`: Host в desktop Chromium + Member в Android Chrome, затем две desktop-вкладки — тишина. Диагностика комнаты 2026-09-25 07:05–07:09 UTC: оба `audio_joined_muted`, `publishedAudio=false`, `Mic level=0`; указание нажать только Join Audio было неполным. UI и инструкция исправлены в `7cf806d...`, новая ручная проверка после Unmute — pending. |
| Визуальная проверка обычного вида сцены и читаемости страниц PDF (D04/D08) | not-run как ручной gate; E2E проверяет rendered surface, но не заменяет осмотр людьми. |

Для записи реального результата используйте [шаблон отчёта](report-template.md) и [D01–D08 checklist](README.md#чек-лист-встречи). При отрицательном результате — `REWORK_REQUIRED`; CI и опубликованный SHA сами по себе не закрывают ручные AC.

## Rollback и повторные запуски

- [Staging run 36030173287](https://github.com/vrata-labs/platform/actions/runs/36030173287): rollout и rollback остановились на недоступных образах Quay (401); публичный health оставался доступен. Исправлен staging helper: старые Docker Hub/Quay references временно отображаются на pinned YCR manifest digests, исходный Compose восстанавливается.
- [Staging runs 36040733010](https://github.com/vrata-labs/platform/actions/runs/36040733010) и [36055010435](https://github.com/vrata-labs/platform/actions/runs/36055010435): ошибки staging tests; автоматические rollback завершились успешно. В следующем прогоне исправлены точность auth oracle и последовательность/временные границы media tests.
- [Run 36067661739](https://github.com/vrata-labs/platform/actions/runs/36067661739): исходный demo gate зелёный, rollback **не запускался**, но позднее обнаружен ручной отказ D02 из-за оставленного muted-состояния.
- Итоговый [run 36114986345](https://github.com/vrata-labs/platform/actions/runs/36114986345): после UI-коррекции gate зелёный, rollback **не запускался**. Автоматический demo cleanup завершён; ручная комната, общие комнаты и каталог сохранились.
