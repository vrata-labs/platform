# M1.7 — удаленный браузерный объект

## Итог реализации

Статус: `done` по состоянию на 2026-05-21.

M1.7 принят как отдельный удаленный браузерный объект: `apps/remote-browser` управляет Chromium session, URL остаются allowlisted, ввод идет через authoritative room-state command path, а результат публикуется как LiveKit viewport stream на медийную поверхность.

Финальный deployed commit: `c6023ec1ae4e3ba4d75e7bb284be2bdb30f01828`.

Проверки:

- focused local remote-browser/runtime checks: passed;
- Docker audio probe: passed;
- full local E2E: `90 passed` with `--workers=2`;
- CI `26223417565`: passed;
- Docker Publish `26223417566`: passed;
- Staging Deploy `26223562956`: passed;
- staging gate: `35 passed` on deployed SHA `c6023ec1ae4e3ba4d75e7bb284be2bdb30f01828`.

Принятое ограничение этапа: на VR и мобильных устройствах аудио может подтормаживать. Это остается QoS/performance follow-up после закрытия M1.7 и не возвращает продуктовый путь к JPEG frame stream или muted/video-only success.

Следующий этап: M1.8 — несколько независимых медийных поверхностей и схемы размещения.

## Цель

Реализовать отдельный медийный объект для сценария, где ведущий в виртуальной реальности или обычном браузере управляет веб-страницей на медийной поверхности: кликает, прокручивает, вводит текст и видит результат вместе с остальными участниками.

Это сложнее, чем трансляция экрана ведущего.

## Решение по объему

M1.7 делается как полноценная реализация, а не как mock/prototype.

Полноценная реализация означает:

- отдельный backend-сервис удаленного браузерного исполнителя;
- реальный Chromium/Playwright session per remote-browser object;
- server-side открытие разрешенного URL;
- прием pointer/scroll/keyboard команд от авторизованного управляющего участника;
- поток результата всем зрителям через LiveKit viewport stream, а не через room-state or JPEG product frames;
- lifecycle create/open/input/stop/fail/cleanup покрыт автоматическими тестами и staging deploy.

Полноценная реализация не означает неограниченный облачный браузер для любого сайта. Первый production scope остается allowlisted: только заранее разрешенные домены/тестовые страницы, без persistent browser profile, без пользовательских secrets/cookies и без доступа к внутренним сетям.

Не входит в M1.7:

- произвольный internet browsing без allowlist;
- страницы с пользовательскими логинами, cookies или secrets;
- file upload/download;
- clipboard integration;
- browser extensions;
- несколько одновременных управляющих участников;
- внешний extension protocol для `remote-browser` до M1.9.

## Почему это отдельный объект

Трансляция экрана показывает картинку, но не дает управлять страницей внутри этой картинки.

Удаленный браузерный объект имеет исполнителя:

```text
медийная поверхность
        ↓
протокол ввода поверхности
        ↓
команды клика / прокрутки / клавиатуры
        ↓
удаленный браузерный исполнитель
        ↓
страница меняется
        ↓
изображение исполнителя транслируется назад
        ↓
участники видят результат
```

## Что такое удаленный браузерный исполнитель

Удаленный браузерный исполнитель — изолированный процесс браузера, который открывает адрес и принимает команды ввода.

В M1.7 он реализуется как отдельный сервис, а не откладывается на позднюю фазу и не заменяется локальной имитацией.

## Сервисы и транспорт

Минимальный состав:

- `apps/remote-browser`: сервис исполнителя на Node.js + Playwright/Chromium;
- `apps/room-state`: authoritative room/object state, permission checks and accepted command sequencing;
- `apps/api`: issuing scoped media/service tokens after room/object membership checks;
- `apps/runtime-web`: surface renderer, input adapter and LiveKit viewport track consumer.

Executor write/control API is internal-only on the compose network. Runtime clients must not call executor write endpoints directly.

Command flow:

```text
runtime SurfaceInputEvent / open-url command
        ↓
room-state validates room, role, objectId, controller lock and expectedRevision
        ↓
room-state forwards accepted command to remote-browser executor over internal network
        ↓
executor applies command to Chromium session
        ↓
executor reports status/error metadata back to room-state
```

Result flow:

```text
Chromium controlled page viewport
        ↓
remote-browser LiveKit viewport video/audio tracks, max fps/resolution bounded
        ↓
runtime attaches the subscribed viewport video track to the media surface and plays audio through the normal remote audio path
```

Room-state stores only metadata: object status, URL, title, session id, media participant/track ids, revisions and diagnostics. It must not carry image frames or high-frequency frame payloads.

Viewport media publishing uses scoped service/media tokens for `remote-browser:<objectId>` identities. Tokens are not persisted in room-state.

## Минимальная архитектура

### Сторона комнаты

- медийная поверхность;
- объект `remote-browser`;
- ввод через `SurfaceInputEvent`;
- видеопоток результата;
- состояние адреса, загрузки и ошибок.

### Сторона исполнителя

- отдельный процесс браузера;
- открытие разрешенного адреса;
- прием событий ввода;
- формирование LiveKit viewport video/audio stream;
- возврат статуса загрузки;
- остановка по команде.

## Состояние объекта

```ts
type RemoteBrowserObjectState = {
  status: 'idle' | 'starting' | 'loading' | 'active' | 'stopping' | 'failed';
  ownerParticipantId: string;
  surfaceId: string;
  controllerParticipantId?: string;
  executorSessionId?: string;
  mediaParticipantId?: string;
  mediaTrackSid?: string;
  audioTrackSid?: string;
  currentUrl?: string;
  title?: string;
  loadedAtMs?: number;
  lastFrameAtMs?: number;
  lastInputSeq?: number;
  errorCode?:
    | 'url_not_allowed'
    | 'url_resolution_blocked'
    | 'redirect_not_allowed'
    | 'executor_unavailable'
    | 'executor_crashed'
    | 'executor_timeout'
    | 'navigation_failed'
    | 'input_rejected'
    | 'stream_failed'
    | 'audio_capture_failed'
    | 'audio_publish_failed'
    | 'unknown';
};
```

## Команды объекта

```ts
type RemoteBrowserCommand =
  | { type: 'open-url'; url: string }
  | { type: 'pointer'; event: SurfaceInputEvent }
  | { type: 'scroll'; event: SurfaceInputEvent }
  | { type: 'keyboard'; event: SurfaceInputEvent }
  | { type: 'reload' }
  | { type: 'take-control' }
  | { type: 'release-control' }
  | { type: 'stop' };
```

## Безопасность и ограничения

Удаленный браузерный объект не должен в первой версии открывать что угодно без ограничений.

Минимальные правила:

1. Запрещены внутренние адреса:
   - `localhost` и любые localhost aliases;
   - `127.0.0.0/8`;
   - `0.0.0.0/8`;
   - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`;
   - IPv6 loopback/link-local/unique-local ranges;
   - cloud metadata addresses, including `169.254.169.254`;
   - private DNS targets after resolution.
2. Запрещены схемы, кроме `https` и, при необходимости разработки, явно разрешенного `http` для локальной проверочной страницы.
3. Каждый navigation и redirect заново проходит allowlist, DNS/IP validation and private-range checks.
4. Нужен список разрешенных доменов или режим «только демонстрационные домены» для первой версии.
5. Ввод принимает только участник с правом `remote-browser.input` и активным controller lock.
6. Открытие URL требует `remote-browser.open-url`.
7. Остановка требует `remote-browser.stop` или роль `host/admin` через `surface.stop-object`.
8. Один управляющий участник за раз.
9. Все команды открытия адреса и ввода пишутся в журнал диагностики.
10. Browser context non-persistent: no saved cookies, no saved local profile, downloads disabled, clipboard/camera/microphone/geolocation denied.
11. Executor has resource limits: max sessions, max session lifetime, idle timeout, max fps/resolution, input rate limit, memory/CPU limits and crash cleanup.
12. Owner leave stops the session unless an explicit host/admin handoff is implemented in this phase.
13. Controller leave releases controller lock; it must not leave the browser permanently locked.

## Первый production scope

Чтобы не раздувать фазу и при этом сделать полноценную реализацию, первый production scope должен быть таким:

- открыть только заранее разрешенный домен или internal demo page, опубликованную через staging;
- кликать кнопки на этой странице через общий `SurfaceInputEvent`;
- прокручивать страницу;
- вводить короткий текст в controlled input;
- видеть реальный Chromium-rendered результат на поверхности у всех участников;
- остановить объект и гарантированно закрыть Chromium session;
- подтвердить протокол ввода и видеопоток;
- не делать неограниченный browser-as-a-service для любого сайта.

## Задачи агента

1. Зарегистрировать тип объекта `remote-browser`.
2. Добавить состояние объекта.
3. Добавить `apps/remote-browser` executor service with Playwright/Chromium.
4. Добавить internal executor API: create session, open URL, apply input, publish viewport stream, stop session, health.
5. Подключить `room-state` к executor API для server-side accepted command forwarding.
6. Подключить LiveKit viewport track consumer в runtime и отрисовку на surface texture.
7. Подключить события `SurfaceInputEvent` к executor через authoritative command path.
8. Добавить проверку разрешенных адресов, redirects and resolved IPs.
9. Добавить управление фокусом, controller lock and surface blocking.
10. Добавить диагностику:

```ts
remoteBrowser: {
  objectId: string;
  surfaceId: string;
  status: string;
  currentUrl?: string;
  executorSessionId?: string;
  executorConnected: boolean;
  lastInputSeq?: number;
  lastInputKind?: string;
  mediaConnected: boolean;
  mediaHasVideo: boolean;
  mediaHasAudio: boolean;
  mediaParticipantId?: string;
  mediaTrackSid?: string;
  audioTrackSid?: string;
  lastFrameAtMs?: number;
  connectedViewerCount: number;
  errorCode?: string;
}
```

11. Добавить docker/compose/staging wiring for `remote-browser` with resource limits and healthcheck.
12. Добавить API endpoint for scoped remote-browser media token issuance.

## Автоматические проверки

Создать:

```text
tests/e2e/m1-media/remote-browser-object.spec.ts
```

Проверки:

1. Ведущий может создать объект `remote-browser` на поверхности.
2. Гость не может создать объект.
3. Разрешенная тестовая страница открывается.
4. Запрещенный URL отклоняется с `url_not_allowed`.
5. Redirect на запрещенный URL отклоняется с `redirect_not_allowed`.
6. URL, который резолвится в private/internal IP, отклоняется.
7. Клик по кнопке на поверхности меняет состояние реальной Chromium-страницы.
8. Прокрутка меняет положение страницы.
9. Ввод текста меняет controlled input на странице.
10. Имитация луча виртуальной реальности создает клик в удаленном браузере.
11. Второй участник видит LiveKit viewport stream после изменения страницы.
12. Участник без controller lock не может отправить input.
13. При выходе ведущего объект останавливается или блокируется согласно политике.
14. При сбое исполнителя объект переходит в `failed`, но комната продолжает работать.
15. Stop закрывает Chromium session and viewport media stream.

Unit/integration tests:

- URL validation: schemes, localhost aliases, IPv4/IPv6 private ranges, metadata IP, redirects, DNS/IP mismatch.
- Command reducer: permissions, revision, controller lock, stale/duplicate commands.
- Executor session lifecycle: create, open, input, viewport media publish, stop, crash cleanup.
- Runtime renderer: LiveKit viewport track updates surface texture and does not route frames through room-state.

CI/staging checks:

- `pnpm run lint`;
- `pnpm run typecheck`;
- `pnpm run build`;
- `pnpm run test`;
- focused local `tests/e2e/m1-media/remote-browser-object.spec.ts`;
- full local `pnpm test:e2e`;
- after deploy: CI, Docker Publish, Staging Deploy gate, `pnpm test:e2e:staging`, and focused staging `remote-browser-object` run.

## Критерии готовности

Подфаза закрыта, если:

- удаленный браузерный объект работает как отдельный медийный объект;
- ввод проходит через общий протокол поверхности;
- есть отдельный полноценный remote-browser executor service;
- результат реального Chromium session виден всем участникам на поверхности через LiveKit viewport stream;
- URL проверяются;
- redirects and resolved IPs проверяются;
- ввод доступен только участнику с правами;
- executor lifecycle and cleanup работают на staging;
- автоматические проверки проходят на тестовой странице;
- commit/push, CI, Docker Publish, Staging Deploy gate and staging verification are complete for the deployed commit.

## Что не считать готовностью

- Клик лучом работает только как локальная анимация и не влияет на страницу.
- Объект открывает произвольные внутренние адреса.
- Исполнитель работает только вручную и не покрыт автоматическими проверками.
- Исполнитель заменен mock stream without real browser execution.
- Объект реализован как особый случай ядра.
- Видеотрансляция экрана названа управляемым браузером, хотя ввод в страницу не работает.
