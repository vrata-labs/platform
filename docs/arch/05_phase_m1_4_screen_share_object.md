# M1.4 — объект трансляции экрана ведущего

## Цель

Реализовать медийный объект, который показывает экран, окно или вкладку ведущего на выбранной медийной поверхности.

Это первая по-настоящему полезная деловая функция после голоса и присутствия.

## Важное разделение

Трансляция экрана — это видеопоток.

VRATA не читает содержимое сайта, не анализирует HTML и не нажимает кнопки внутри чужой страницы. Ведущий сам управляет тем, что показывает, а остальные участники видят поток.

Если нужно нажимать кнопки произвольной веб-страницы из VR-луча, это не эта подфаза. Это подфаза удаленного браузерного объекта.

## Не входит в M1.4

- зеркалирование одного потока на несколько поверхностей;
- схемы размещения нескольких поверхностей;
- управление содержимым чужой веб-страницы;
- внешний протокол расширений;
- новая media transport архитектура вместо текущего LiveKit пути.

## Пользовательский сценарий

1. Ведущий входит в комнату.
2. Ведущий выбирает поверхность.
3. Ведущий нажимает «Начать трансляцию экрана».
4. Браузер предлагает выбрать экран, окно или вкладку.
5. После выбора поток появляется на поверхности.
6. Остальные участники видят поток на этой поверхности.
7. Ведущий останавливает трансляцию.
8. Поверхность очищается или возвращается в состояние ожидания.

## Состояние объекта

```ts
type ScreenShareObjectState = {
  status: 'idle' | 'selecting' | 'publishing' | 'active' | 'stopping' | 'stopped' | 'failed';
  ownerParticipantId: string;
  surfaceId: string;
  mediaTrackSid?: string;
  startedAtMs?: number;
  stoppedAtMs?: number;
  errorCode?:
    | 'display_capture_unsupported'
    | 'display_capture_denied'
    | 'display_capture_failed'
    | 'media_network_blocked'
    | 'track_unpublished'
    | 'unknown';
};
```

## Server-side protocol

`screen-share` должен быть обычным медийным объектом поверх M1.3, а не параллельной локальной функцией runtime.

Минимальные команды:

- `surface.create-object` с `objectType = 'screen-share'` создает объект в состоянии `idle`;
- `surface.patch-object-state` применяет только валидные `screen-share` patches через reducer и `expectedRevision`;
- `surface.stop-object` очищает active object на surface и останавливает объект;
- выход owner из комнаты переводит активный `screen-share` в безопасное состояние или очищает surface.

Минимальные patches:

```ts
type ScreenSharePatch =
  | { type: 'mark-selecting' }
  | { type: 'mark-publishing' }
  | { type: 'mark-active'; mediaTrackSid: string }
  | { type: 'mark-failed'; errorCode: ScreenShareErrorCode }
  | { type: 'mark-stopped' };
```

Правила:

- `surface.create-object` и `surface.stop-object` доступны только `host` / `admin` через M1.1 permissions;
- patches принимает только owner объекта или `host` / `admin`, если политика явно разрешает stop/failure cleanup;
- stale `expectedRevision` отклоняется;
- `mediaTrackSid` задается только после успешной публикации;
- rejected commands update diagnostics and do not mutate room state.

## Перенос legacy screen share пути

Существующий runtime path `startScreenShare` / `stopScreenShare` должен стать adapter/controller для объекта `screen-share`:

- UI кнопка создает `screen-share` на выбранной surface через room-state command;
- capture/publish выполняется только после принятого create;
- публикация LiveKit track обновляет state объекта через reducer;
- remote rendering ищет `surfaceId` по active object в room state, а не выбирает surface внутри media transport;
- mock provider and real `getDisplayMedia` / LiveKit provider используют один lifecycle path;
- direct local texture path допустим только как implementation detail выбранного object controller, не как отдельный продуктовый путь.

## Медиа-маршрут

```text
getDisplayMedia или LiveKit screen share helper
        ↓
локальная видеодорожка ведущего
        ↓
публикация через LiveKit
        ↓
подписка другими участниками
        ↓
поиск surfaceId в состоянии комнаты
        ↓
видеотекстура на поверхности
```

Состояние комнаты должно знать, какая дорожка прикреплена к какой поверхности. Слой медиа-транспорта не должен сам решать, куда выводить поток.

## Несколько поверхностей

В первой версии один поток можно прикрепить к одной основной поверхности.

Зеркальное отображение одного потока на нескольких поверхностях не входит в M1.4 и относится к M1.8.

Рекомендуемое правило:

- один объект `screen-share` владеет одним источником потока;
- несколько поверхностей могут показывать один объект как зеркало только через явную настройку `mirrors`.

```ts
type ScreenShareMirrorState = {
  primarySurfaceId: string;
  mirrorSurfaceIds: string[];
};
```

## Ухудшенные режимы

Объект должен корректно объяснять:

- захват экрана не поддерживается браузером;
- пользователь отказал в выборе экрана;
- медиа-соединение заблокировано сетью;
- поток был остановлен системно;
- ведущий вышел из комнаты.

## Задачи агента

1. Зарегистрировать тип объекта `screen-share`.
2. Добавить кнопку запуска только для роли ведущего.
3. Реализовать создание объекта на выбранной поверхности.
4. Реализовать запуск захвата экрана.
5. Реализовать публикацию видеодорожки через текущий медиа-транспорт.
6. Реализовать привязку дорожки к поверхности.
7. Реализовать получение и отображение видеодорожки у других участников.
8. Реализовать остановку трансляции.
9. Реализовать очистку поверхности после остановки.
10. Добавить диагностические поля:

```ts
screenShare: {
  supported: boolean;
  active: boolean;
  localPublishing: boolean;
  selectedSurfaceId?: string;
  publishedTrackSid?: string;
  remoteSubscribedTrackCount: number;
  errorCode?: string;
}
```

Порядок работ:

1. Shared types for `screen-share` state, patches, error codes and allowed object type.
2. Room-state reducer and command handling for `screen-share` lifecycle.
3. Runtime room-state client helpers for create/patch/stop.
4. Runtime controller adapter over current LiveKit/mock screen share path.
5. Surface texture routing through active `screen-share` object state.
6. Unit tests and focused two-client e2e.
7. Full local verification, commit/push, CI, Docker Publish, Staging Deploy gate, staging focused verification.

## Автоматические проверки

Реальный выбор экрана в браузере не всегда надежно автоматизируется. Поэтому проверки делятся на два уровня.

### Уровень 1. Автоматические проверки с подмененным медиа-провайдером

Создать:

```text
tests/e2e/m1-media/screen-share-object.spec.ts
```

Проверки:

1. Ведущий может создать объект `screen-share` на поверхности.
2. Гость не может создать объект `screen-share`.
3. При успешной подмененной публикации состояние становится `active`.
4. Другой участник видит `activeObjectType = 'screen-share'`.
5. Другой участник видит привязанную видеодорожку в отладочных данных.
6. Остановка трансляции очищает поверхность.
7. Выход ведущего переводит объект в безопасное состояние.
8. Ошибка `display_capture_unsupported` отображается в интерфейсе и отладке.
9. Ошибка `media_network_blocked` не ломает комнату.
10. stale patch with wrong `expectedRevision` is rejected.
11. Creating on occupied surface is rejected.
12. Stop with wrong `objectId` is rejected.
13. Owner leave/unpublish cleans up or marks the object safe without breaking the room.

Unit-тесты должны покрывать:

- reducer status transitions;
- permission matrix for create/stop/patch;
- invalid patch and stale revision rejection;
- owner leave / track unpublished cleanup behavior;
- runtime uses the same lifecycle for mock and real provider paths.

CI/staging checks:

- `pnpm run lint`;
- `pnpm run typecheck`;
- `pnpm run build`;
- `pnpm run test`;
- focused local `tests/e2e/m1-media/screen-share-object.spec.ts`;
- full local `pnpm test:e2e`;
- after deploy: `pnpm test:e2e:staging` and focused `screen-share-object` staging run.

### Уровень 2. Финальная ручная проверка

Проверить реальный выбор вкладки, окна или экрана в браузере.

## Критерии готовности

Подфаза закрыта, если:

- ведущий может запустить трансляцию экрана на выбранной поверхности;
- участники видят поток на поверхности;
- остановка очищает поверхность;
- ошибки захвата и медиа-сети объясняются;
- автоматические проверки проходят с подмененным медиа-провайдером;
- финальная ручная проверка подтверждает реальный захват экрана;
- commit/push, CI, Docker Publish, Staging Deploy gate and staging verification are complete for the deployed commit.

## Что не считать готовностью

- Поток появляется только в обычном HTML-окне, но не на поверхности в комнате.
- Поток не привязан к `surfaceId` в состоянии комнаты.
- Запуск доступен гостю.
- Ошибки захвата экрана скрываются за общей ошибкой.
- Реализация встроена в ядро без медийного объекта.
