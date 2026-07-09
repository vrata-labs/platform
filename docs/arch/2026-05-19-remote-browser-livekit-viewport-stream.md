# Remote Browser LiveKit Viewport Stream

## Итог 2026-05-21

Статус: `accepted` for M1.7 stage completion.

Результат принят на staging как основной product path: `remote-browser` публикует viewport через LiveKit, runtime рендерит subscribed track на медийной поверхности, ввод остается через authoritative room-state path, а аудио не принимается как muted/video-only success.

Финальный deployed commit: `c6023ec1ae4e3ba4d75e7bb284be2bdb30f01828`.

Проверки:

- focused local remote-browser/runtime checks: passed;
- Docker audio probe: passed;
- full local E2E: `90 passed` with `--workers=2`;
- CI `26223417565`: passed;
- Docker Publish `26223417566`: passed;
- Staging Deploy `26223562956`: passed;
- staging gate: `35 passed` on deployed SHA `c6023ec1ae4e3ba4d75e7bb284be2bdb30f01828`.

Принятое ограничение: на VR и мобильных устройствах звук может подтормаживать. Это остается отдельной QoS/performance задачей после M1.7; возвращать JPEG `/frames`, `<video>.captureStream()` fallback или muted/video-only success не нужно.

## Цель

Перевести `remote-browser` с текущей гибридной схемы `JPEG screenshots + WebRTC captureStream(<video>)` на один полноценный WebRTC-поток всего browser viewport через тот же LiveKit media-plane, который уже используется для screen sharing.

Ожидаемый результат:

- Rutube и другие video-сайты видны плавно, без ощущения покадрового JPEG playback.
- Controls, subtitles, popovers, cookie banners, menus и любые DOM-overlays являются частью одного видеопотока, а не отдельным screenshot-слоем.
- Ввод остается через существующий authoritative `room-state` command path: surface input -> room-state validation -> internal executor input API.
- `remote-browser` остается управляемым server-side browser object, а не пользовательским screen share.

## Не-цель

- Не оставляем продуктовый fallback на JPEG frame stream, screenshot overlay hold или `<video>.captureStream()`.
- Не делаем общий browser-as-a-service без allowlist, private-IP protection и session limits.
- Не добавляем пользовательские cookies, persistent profile, login storage, downloads, clipboard, camera/microphone/geolocation permissions.
- Не меняем ownership локальной pose/locomotion architecture runtime.
- Не решаем multi-surface mirroring; один active `remote-browser` по-прежнему владеет одной media surface.
- Не делаем site-specific Rutube integration; решение должно работать на уровне viewport stream.

## Продуктовый контракт аудио

Аудио для remote-browser viewport stream обязательно.

- Rutube/video-site acceptance requires both smooth video and audible remote audio.
- Capture/publish path must produce a LiveKit video track and an audio track when the page emits audio.
- If viewport video capture succeeds but audio capture/publish fails, object must not silently degrade to muted success. It must expose explicit `audio_capture_failed` / `audio_publish_failed` or equivalent error and fail the focused Rutube acceptance until audio is fixed.
- Runtime must keep normal remote audio playback path, not route remote-browser audio only through visual texture code.

## Предпосылки и ограничения

- `screen-share` уже публикует LiveKit `ScreenShare` track и runtime умеет выводить subscribed video track как `THREE.VideoTexture` на `displaySurface`.
- `remote-browser` уже имеет отдельный executor service `apps/remote-browser` на Playwright/Chromium, URL allowlist, internal input API и room-state forwarding.
- Сейчас `remote-browser` открывает страницу в headless Chromium и возвращает результат через `/frames` WebSocket плюс direct WebRTC для найденного `<video>`; именно эта split-layer архитектура создает конфликт плавного видео и DOM controls.
- Финальный путь должен быть без fallback: failure to capture/publish viewport is `remote-browser.status = failed` with explicit `errorCode`, not downgrade to JPEG.
- Для staging обязательно использовать нормальный pipeline: commit -> push -> Docker Publish -> Staging Deploy -> staging verification.
- План допускает test doubles для unit/e2e в CI, но они не являются продуктовым fallback и не должны включаться в staging/prod runtime path.

## Подход

Выбранный подход: remote-browser executor становится LiveKit publisher полного browser viewport.

Поток результата:

```text
Playwright/Chromium remote-browser page
        ↓
server-side viewport capture, including DOM overlays and page video
        ↓
executor publisher page / capture adapter publishes LiveKit video track
        ↓
room-state stores remoteBrowser.mediaTrackSid / mediaParticipantId
        ↓
runtime subscribes to LiveKit track and renders it on active media surface
```

Поток ввода остается прежним:

```text
runtime SurfaceInputEvent
        ↓
room-state permission/revision/controller validation
        ↓
internal remote-browser executor input API
        ↓
Playwright mouse/keyboard/scroll on the controlled page
```

Capture provider для первой полноценной реализации:

- Запускать remote-browser Chromium в headed mode внутри virtual display контейнера.
- Для каждой active session использовать отдельный browser/context/page boundary, чтобы capture source был однозначным и не смешивался между комнатами.
- Использовать Chromium display/tab capture через `getDisplayMedia({ video: true, audio: true })` в executor-owned publisher page, с auto-select flags для controlled environment.
- Publisher page подключается к LiveKit с token, выданным API для service identity `remote-browser:<objectId>`.
- Если Linux/container/browser combination не дает стабильный video+audio capture на staging, implementation blocked until capture provider is replaced by another full-viewport provider. JPEG/direct-video fallback не вводится.
- LiveKit identity/source mapping must distinguish remote-browser tracks from user screen-share tracks. Runtime must attach remote-browser tracks by `RemoteBrowserObjectState.mediaParticipantId` / `mediaTrackSid`, not by first available `Track.Source.ScreenShare` publication.

Отклоненные подходы:

- `CDP Page.startScreencast` как основной путь: это опять screenshot frames, только завернутые в другой транспорт.
- Поднимать screenshot FPS во время hover: возвращает backlog/CPU/network risk и не решает универсальность controls.
- Оставить `<video>.captureStream()` и дорисовывать overlays: лучше текущего, но все равно эвристика, не универсальная для canvas/video/DOM combinations.

## Этапы внедрения

### Phase 0 — Capture feasibility gate

- [ ] Собрать минимальный executor-only spike в `apps/remote-browser`: headed Chromium in container + virtual display + publisher page.
- [ ] Доказать в staging-like Docker environment, что полный viewport Rutube stream публикуется в LiveKit как один video track.
- [ ] Доказать, что audio from Rutube page публикуется как LiveKit audio track and is audible to a remote viewer.
- [ ] Доказать, что DOM controls поверх video видны в этом же stream.
- [ ] Доказать, что video remains smooth for at least 90 seconds under hover and click activity.
- [ ] Зафиксировать конкретный working capture provider: required packages, Chromium flags, virtual display/audio setup, env vars and known limitations.
- [ ] Если Phase 0 не проходит, implementation stops; JPEG/direct-video fallback не вводится.

### Phase 1 — State, auth and media routing contract

- [ ] Обновить shared remote-browser state and patches for viewport media identity, track SIDs, stream status and stream errors.
- [ ] Добавить internal service auth for executor callbacks and LiveKit publish-token issuance.
- [ ] Зафиксировать LiveKit identity/source mapping for `remote-browser:<objectId>` and runtime lookup rules.
- [ ] Добавить reducer tests before executor/runtime wiring.

### Phase 2 — Executor viewport publisher

- [ ] Replace product result path in executor with session-scoped viewport capture and LiveKit publishing.
- [ ] Keep accepted input API and URL policy unchanged.
- [ ] Add session resource limits and deterministic cleanup.
- [ ] Add component tests for publish success, audio failure, capture failure, LiveKit disconnect and stop cleanup.

### Phase 3 — Runtime track routing

- [ ] Route subscribed remote-browser LiveKit tracks to the active media surface by object state.
- [ ] Keep user screen-share routing separate and covered by regression tests.
- [ ] Update diagnostics and UI status.

### Phase 4 — Remove old product rendering paths

- [ ] Remove product dependency on `/frames`, JPEG overlay hold and `<video>.captureStream()` only after Phase 2/3 tests pass.
- [ ] Keep any remaining screenshot endpoint only if it is explicitly diagnostic, non-product and not used by runtime rendering.

### Phase 5 — Verification and staging rollout

- [ ] Run local package build/unit tests.
- [ ] Run full local `pnpm test:e2e`.
- [ ] Commit/push and verify CI + Docker Publish.
- [ ] Deploy through normal Staging Deploy workflow.
- [ ] Run staging gate plus focused Rutube viewport/audio test on temporary BlueOffice room.

## Задачи

- [ ] Зафиксировать целевой контракт `remote-browser` без fallback: один active viewport media track или explicit failure.
- [ ] Добавить в `RemoteBrowserObjectState` поля для LiveKit route: `mediaParticipantId`, `mediaTrackSid`, `audioTrackSid`, `streamStartedAtMs`, `streamUpdatedAtMs`, `streamErrorCode` или эквивалентные минимальные поля.
- [ ] Обновить remote-browser reducer в `apps/room-state/src/state.ts`: `open-url` переводит объект в `loading/publishing`, executor callback переводит в `active` только после опубликованного LiveKit track.
- [ ] Добавить internal service-auth callback для executor -> room-state/API: `mark-publishing`, `mark-active(mediaTrackSid)`, `mark-failed(errorCode)`, `mark-stopped`.
- [ ] Добавить API endpoint для выдачи LiveKit publish token remote-browser executor service identity, защищенный internal service token или equivalent compose-only secret.
- [ ] Передать executor service нужные env: internal API URL, service token, LiveKit URL/token endpoint, capture mode, viewport width/height/fps/audio policy.
- [ ] Перестроить `apps/remote-browser`: session lifecycle создает controlled page и отдельный publisher/capture page вместо `/frames` result stream.
- [ ] Перевести Chromium launch с singleton headless browser на session-scoped headed capture-compatible browser/context under virtual display, с лимитами max sessions / session lifetime / idle timeout.
- [ ] Обновить Dockerfile remote-browser: установить необходимые runtime packages для virtual display / Chromium screen capture / audio capture, без интерактивных prompts.
- [ ] Обновить compose/staging env: добавить capture-specific env и resource limits; сохранить incremental rollout behavior.
- [ ] Реализовать publisher page bundle в executor: получить viewport capture stream with audio, подключиться к LiveKit, publish video+audio, report track SIDs/status.
- [ ] Сохранить URL allowlist, redirect validation, private IP blocking, denied permissions, no persistent profile.
- [ ] Сохранить input path: `room-state` forwards accepted pointer/scroll/keyboard patches to executor internal input API.
- [ ] Удалить runtime dependency on remote-browser `/frames` WebSocket for product rendering.
- [ ] Удалить/заморозить product usage of `createMediaAnswerInFrame`, `sourceRect`, screenshot overlay hold and video-element capture compositing.
- [ ] Обновить runtime `remote-browser` rendering: find active object by `mediaTrackSid` / executor participant identity and attach subscribed LiveKit track to target surface via shared media-surface video texture path.
- [ ] Обновить runtime audio route: remote-browser audio track is subscribed and played audibly through the normal LiveKit remote audio path.
- [ ] Обобщить current `attachVideoTrack` / `detachVideoTrack` screen-share helpers into reusable media-surface video attachment utilities if это уменьшит дублирование без большого refactor.
- [ ] Обновить diagnostics: expose `remoteBrowser.mediaConnected`, `mediaHasVideo`, `mediaHasAudio`, `mediaTrackSid`, `audioTrackSid`, `mediaParticipantId`, `viewportStreamState`, `captureFps`, `inputLatencyMs`, `streamErrorCode`.
- [ ] Обновить UI status text: distinguish loading page, publishing viewport stream, active, failed capture, failed LiveKit publish.
- [ ] Удалить или ограничить `/api/tokens/remote-browser-frame` and `/frames` usage после переноса, если больше нет product consumers.
- [ ] Обновить документацию/AGENTS notes только если появятся новые обязательные operational rules.
- [ ] Провести staging Rutube validation на временной BlueOffice room, не трогая живую комнату пользователя.

## Затронутые файлы/модули

- `packages/shared-types/src/media-objects.ts`: state/patch/error-code contract for remote-browser viewport media.
- `apps/room-state/src/state.ts`: reducer and permissions for new remote-browser stream lifecycle.
- `apps/room-state/src/index.ts`: accepted command forwarding and internal executor callbacks.
- `apps/api/src/index.ts`: internal LiveKit media token issuance for remote-browser executor.
- `apps/remote-browser/src/index.ts`: session lifecycle, Chromium launch mode, viewport capture, LiveKit publish, status callbacks, input API.
- `apps/remote-browser/Dockerfile`: virtual display / browser capture dependencies.
- `infra/docker/compose.staging.yml`: environment and service wiring.
- `infra/docker/.env.staging.example`: documented env defaults.
- `infra/docker/rollout-staging-images.sh`: staging env propagation if new required vars are needed.
- `apps/runtime-web/src/main.ts`: LiveKit track routing to active remote-browser surface.
- `apps/runtime-web/src/media/remote-browser-object.ts`: remove direct frame stream rendering path or reduce it to non-product diagnostics only.
- `apps/runtime-web/src/media/media-objects.ts` / related helpers if track-to-surface selection needs shared code.
- `tests/e2e/m1-media/remote-browser-object.spec.ts`: deterministic local remote-browser flow.
- `tests/e2e/m1-media/remote-browser-rutube.spec.ts`: real Rutube staging flow.
- `tests/e2e/m1-media/screen-share-object.spec.ts`: regression guard for existing screen-share behavior.

## Тест-план

### Unit

- [ ] `shared-types`: remote-browser state accepts media fields and rejects invalid patch shapes.
- [ ] `room-state`: `open-url` creates/keeps executor session and moves to publishing/loading state without `frameStreamId` dependency.
- [ ] `room-state`: executor `mark-active(mediaTrackSid)` makes object active only for matching room/object/session.
- [ ] `room-state`: stale/duplicate input events still rejected; controller lock still enforced.
- [ ] `room-state`: executor `mark-failed` records explicit error and does not leave surface in half-active state.
- [ ] `api`: internal media-token endpoint requires service auth and grants publish rights only for scoped `remote-browser:<objectId>` identity.
- [ ] `remote-browser`: capture config parser clamps fps/viewport/session limits and rejects invalid env.
- [ ] `remote-browser`: URL policy and private-address tests remain green.
- [ ] `runtime-web`: active remote-browser object maps subscribed LiveKit track to the correct surface.
- [ ] `runtime-web`: screen-share track routing still works and does not attach remote-browser track as a human screen share.

### Integration / component

- [ ] Executor session create starts controlled page and publisher page, reports `publishing`, then `active` with track SID in a controlled test setup.
- [ ] Executor input API moves mouse/click/scroll/keyboard on the controlled page while LiveKit publisher remains connected.
- [ ] Executor stop closes Chromium session, unpublishes track, closes LiveKit connection and reports stopped/failed cleanup.
- [ ] Capture provider smoke test proves full viewport includes DOM overlay over video in one stream, not separate screenshot layers.
- [ ] Capture provider smoke test proves page audio is present in the published LiveKit audio track.
- [ ] Negative test: capture permission/provider failure results in `remote-browser.status=failed` and no JPEG fallback.
- [ ] Negative test: LiveKit publish failure results in `streamErrorCode`, cleanup and no active object.

### E2E local

- [ ] Existing `pnpm test:e2e` remains green.
- [ ] Remote-browser deterministic demo page opens and is rendered via LiveKit track, not `/frames` WebSocket.
- [ ] Input through room-state still changes page content visible on the surface.
- [ ] Two clients see the same remote-browser viewport stream.
- [ ] Two clients hear the same remote-browser page audio when the page emits audio.
- [ ] Stop object removes the track from all viewers and clears the surface.
- [ ] Existing screen-share E2E remains green to prove no regression in user screen sharing.
- [ ] Regression: user screen-share and remote-browser viewport stream can exist in separate sessions without track routing collision.
- [ ] Regression: late-joining runtime attaches existing remote-browser track by object state, not by first available ScreenShare track.

### E2E staging

- [ ] `pnpm test:e2e:staging` passes on deployed SHA.
- [ ] Focused Rutube staging test creates temporary BlueOffice room, opens full Rutube URL, waits for `remoteBrowser.mediaConnected=true`, checks video motion remains smooth during hover, controls are visible without `mediaCompositeHoldActive` / screenshot overlay hold, and remote audio is present.
- [ ] Staging Rutube test samples frame age / stream state for at least 90 seconds to catch reintroduced frame backlog.
- [ ] Hall/BlueOffice scene loading checks remain green because runtime surface rendering changes touch the main room path.

### Manual / operational

- [ ] Inspect staging container health and logs for remote-browser capture start, LiveKit publish, input latency, stop cleanup.
- [ ] Verify CPU/memory on staging during one Rutube session; document expected per-session resource envelope.
- [ ] Verify no public executor write/control API is exposed beyond current internal path.

## Негативные кейсы

- URL blocked by allowlist or private-IP resolution.
- Redirect from allowed URL to blocked origin.
- Capture provider unavailable in container.
- Capture starts video-only but audio is missing: object fails with explicit `audio_capture_failed` / `audio_publish_failed`; muted success is not accepted.
- LiveKit token endpoint rejects missing/invalid service auth.
- LiveKit publish connects then disconnects.
- Controller leaves; lock releases and executor session remains controllable by host/admin policy or stops according to current ownership rules.
- Owner leaves; executor session cleanup remains deterministic.
- Multiple simultaneous sessions hit max-session limit and reject new session with explicit error.
- Runtime joins after stream already active and still attaches existing track.

## Риски и откаты

### Риски

- Chromium `getDisplayMedia`/tab capture may not work reliably in Linux container/headless mode. This is the primary spike risk; no fallback means the feature must not ship until a full-viewport provider works on staging.
- Capturing tab audio in server-side Chromium may require additional PulseAudio/PipeWire/Xvfb setup. Rutube acceptance should explicitly verify audio if audio is in product scope.
- One browser process per session is heavier than current singleton headless browser. Need max-session and idle-timeout limits before staging rollout.
- LiveKit now carries remote-browser video, increasing bandwidth/CPU on the same media plane as voice/screen share.
- Track routing can regress existing user screen-share if remote-browser and screen-share both use `Track.Source.ScreenShare` without clear identity/object mapping.
- Security boundary changes: executor becomes a media publisher identity and needs scoped token issuance plus service auth.
- Audio capture in container is a hard requirement and may require PulseAudio/PipeWire plumbing beyond Xvfb; Phase 0 must prove this before larger refactor.

### Откат

- Product rollback is deployment rollback, not runtime fallback.
- If staging verification fails, use existing staging deploy rollback to previous successful image SHA.
- Keep rollback proof in final report: previous SHA, failed SHA, deploy run URL, and verification result.
- If capture spike fails before merge, do not land partial architecture behind product flags; close the branch or replace capture provider in the plan before implementation continues.
- If Phase 0 passes but later staging audio verification fails, rollback the deployment and do not re-enable JPEG/direct-video fallback as an emergency workaround.

## Definition of Done

- Remote-browser visual result is a single LiveKit viewport stream in normal product path.
- Remote-browser audio result is a LiveKit audio track in normal product path and is audible to remote viewers.
- Runtime no longer depends on remote-browser JPEG `/frames` or `<video>.captureStream()` for product rendering.
- Rutube hover controls are visible while video remains smooth on staging.
- Phase 0 capture feasibility passed on staging-like Docker environment before old rendering path removal.
- Remote-browser LiveKit identity is scoped and distinguishable from user screen-share identities.
- CPU/memory/session cleanup limits are verified under at least one real Rutube session.
- Local build/unit/e2e pass.
- CI and Docker Publish pass.
- Staging Deploy gate passes on the deployed commit.
- Focused Rutube staging E2E passes against a temporary BlueOffice room.
