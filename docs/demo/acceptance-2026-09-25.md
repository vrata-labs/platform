# VRATA-FEAT-033 — redacted acceptance record

Статус: **автоматические проверки завершены; ручная приёмка открыта**. Этот отчёт не является `demo_passed` и не закрывает AC-033-01/03/04/10 без независимого разработчика и четырёх участников.

## Опубликованная версия

- Ветка: `feat/public-demo-scenario`.
- Проверенный и развёрнутый код: `ded3b2791d3d1dc7a6472be7925342e66ed0f5ca`.
- Шаблон: `meeting-room-basic@2.0.0`, сцена: `warm-modern-meeting-room-candidate-01@0.3.4` (pinned repository commit `a237ab799acbee3932846147c9f48bf1d1b4aaa8`).
- Staging: `https://158.160.10.234.sslip.io`, public smoke `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — HTTP 200. Каталог: три active/current reference templates версии `2.0.0`.

## Автоматические доказательства

| Проверка | Результат |
|---|---|
| Local Node 22 lint, typecheck, build, package tests | Пройдены; tools: 112/112, API: 778 passed, 1 existing skipped. |
| Full local `pnpm test:e2e` на финальном дереве | **147/147**. Изолированный Postgres fixture: seed → read-only check → API restart → PDF/notes persistence → cleanup. |
| Source-build из нового clone именно `ded3b279...` | Авторский прогон: generated env 0600, rendered Compose validation, fresh project/volumes, Wave 2 → active, seed/check, PDF checksum и чтение после API restart, полный четырёхконтекстный browser scenario с реальным локальным LiveKit transport, cleanup и повтор по redacted record, rollback каталога в Wave 2, `down -v` только disposable project. **Независимый разработчик ещё не повторил рецепт.** |
| [CI run 36065335848](https://github.com/vrata-labs/platform/actions/runs/36065335848) | Success на `ded3b279...`: lint, typecheck, build, package tests, full E2E, M0.5 acceptance и pinned asset validation. |
| [Docker Publish run 36065335844](https://github.com/vrata-labs/platform/actions/runs/36065335844) | Success: immutable SHA tags API/room-state/remote-browser и проверенные manifest digests вспомогательных MinIO/mc. |
| [Staging Deploy run 36067661739](https://github.com/vrata-labs/platform/actions/runs/36067661739) | Success: rollout SHA, **48/48 staging E2E**, blocking Rutube **1/1**, persisted successful SHA. Hall, BlueOffice, ArtGallery: `loaded` на текущей странице; автоматический demo-сценарий — pass. |

Staging demo runId: `d6e4daa4-39c3-4b87-9682-ab0f205c6e18`; tenantId: `public-demo-794aa1ae-ed73-4cbe-97b7-aee72e0f3784`; roomId: `public-demo-89b8cef2-9d26-4888-8e13-247b264ee6e0`. В artifact `playwright-staging-gate-36067661739-1` приложен **public-demo-cleanup-record**: `completed`, invites revoked, document deleted, session ended, room и tenant deleted. Секретные invite links и admin token в отчёт не включены.

Автоматический D02 использовал synthetic capture source и **настоящий** LiveKit/WebRTC transport с проверкой publish/subscribe, received bytes, spatial node, mute/unmute. Он не доказывает слышимость двух реальных микрофонов.

## Ручная приёмка

| Гейт | Состояние |
|---|---|
| Независимый разработчик повторил чистый clone и recipe (AC-033-01) | not-run: нужен второй разработчик. |
| D01–D08 одновременно с четырьмя людьми на staging (AC-033-03/07) | not-run: нужны четыре участника и обычные браузерные сессии. |
| Двусторонняя слышимость двух реальных микрофонов и mute/unmute (AC-033-04) | not-run: нужны минимум два участника с микрофонами и наушниками. |
| Визуальная проверка обычного вида сцены и читаемости страниц PDF (D04/D08) | not-run как ручной gate; E2E проверяет rendered surface, но не заменяет осмотр людьми. |

Для записи реального результата используйте [шаблон отчёта](report-template.md) и [D01–D08 checklist](README.md#чек-лист-встречи). При отрицательном результате — `REWORK_REQUIRED`; CI и опубликованный SHA сами по себе не закрывают ручные AC.

## Rollback и повторные запуски

- [Staging run 36030173287](https://github.com/vrata-labs/platform/actions/runs/36030173287): rollout и rollback остановились на недоступных образах Quay (401); публичный health оставался доступен. Исправлен staging helper: старые Docker Hub/Quay references временно отображаются на pinned YCR manifest digests, исходный Compose восстанавливается.
- [Staging runs 36040733010](https://github.com/vrata-labs/platform/actions/runs/36040733010) и [36055010435](https://github.com/vrata-labs/platform/actions/runs/36055010435): ошибки staging tests; автоматические rollback завершились успешно. В следующем прогоне исправлены точность auth oracle и последовательность/временные границы media tests.
- Итоговый [run 36067661739](https://github.com/vrata-labs/platform/actions/runs/36067661739): gate зелёный, rollback **не запускался**. Demo cleanup завершён; общие комнаты и каталог сохранились.
