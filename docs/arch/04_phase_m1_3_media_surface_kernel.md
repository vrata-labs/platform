# M1.3 — ядро медийных поверхностей и медийных объектов

## Статус

Статус: `done`.

Фактический результат: M1.3 закрыта 2026-05-12 в commit `ce2aa7ef806996d7fc05594009709ecfa7008585`. Локально прошли `git diff --check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run build`, `pnpm run test`, focused `tests/e2e/m1-media` and full `pnpm test:e2e`.

Staging verification: CI `25747564664`, Docker Publish `25747564641`, Staging Deploy `25748083239`, `pnpm test:e2e:staging` 33/33, focused staging `media-surface-kernel` 3/3.

Стартовый контекст: M1.1 закрыла server-side access foundation, M1.2 закрыла единый `SurfaceInputEvent` и debug/test input sink. M1.3 должна использовать эти результаты, а не создавать параллельный путь ввода или client-side проверку ролей.

## Цель

Создать общий механизм, через который медийные объекты подключаются к поверхностям.

Эта подфаза не реализует всю доску или всю трансляцию экрана. Она создает основу:

- реестр типов объектов;
- создание экземпляра объекта;
- прикрепление объекта к поверхности;
- остановка объекта;
- синхронизация активного объекта между участниками;
- отладочные данные;
- тестовый объект-заглушка.

## Не входит в M1.3

- реальные объекты `screen-share`, `whiteboard`, `host-web-broadcast` или `remote-browser`;
- persistent storage для состояния медийных объектов за пределами текущего состояния комнаты;
- multi-surface layouts beyond one default surface;
- production-grade lock ownership UI;
- реальные media track attach/detach, кроме no-op/test interface;
- внешний протокол расширений для независимых разработчиков.

## Основной результат

После этой подфазы в комнате должна быть хотя бы одна поверхность, на которую можно прикрепить тестовый объект. Все участники должны видеть, что объект активен на этой поверхности.

## Сущности

### Реестр медийных объектов

```ts
type MediaObjectRegistry = {
  register(definition: MediaObjectDefinition, factory: MediaObjectFactory): void;
  get(type: string): MediaObjectDefinition | undefined;
  create(type: string, ctx: MediaObjectMountContext): Promise<MediaObjectController>;
};
```

Реестр в M1.3 должен быть внутренним runtime registry. Он нужен для проверки lifecycle и расширяемости, но не является публичным extension protocol. Реестр должен отклонять неизвестный `objectType` и типы, не разрешенные выбранной поверхностью.

### Контекст монтирования

```ts
type MediaObjectMountContext = {
  roomId: string;
  surfaceId: string;
  objectId: string;
  localParticipantId: string;
  role: 'guest' | 'member' | 'host' | 'admin';

  surface: MediaSurface;
  permissions: RoomPermission[];

  stateApi: {
    patchObjectState(patch: unknown): Promise<void>;
    stopObject(): Promise<void>;
  };

  mediaApi: {
    attachVideoTrack(trackId: string): void;
    detachVideoTrack(trackId: string): void;
  };

  inputApi: {
    setInputEnabled(enabled: boolean): void;
    requestFocus(): void;
  };
};
```

Lifecycle rule: factory получает context один раз при `create(...)`; controller не должен требовать повторный `mount(ctx)`, если это приводит к дублированию состояния. Если выбран вариант с `mount(ctx)`, `create(...)` должен быть чистым factory без side effects.

### Контроллер объекта

```ts
type MediaObjectController = {
  mount(ctx: MediaObjectMountContext): Promise<void>;
  unmount(): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  handleInput?(event: SurfaceInputEvent): Promise<void>;
  handleStateUpdate?(state: unknown): void;
  handleMediaTrack?(track: unknown): void;
};
```

## Состояние комнаты

Добавить в состояние комнаты раздел:

```ts
type RoomMediaObjectsState = {
  surfaces: Record<string, MediaSurface>;
  objects: Record<string, MediaObjectInstance>;
};
```

Служба состояния комнаты является source of truth для `RoomMediaObjectsState`.

Правила совместимости:

- комнаты без `mediaObjects` должны продолжать загружаться;
- при отсутствии `mediaObjects.surfaces` runtime и room-state создают или представляют одну default surface: `debug-main` или `main-screen`, в зависимости от текущего runtime naming;
- server assigns `objectId`, `createdAtMs`, `updatedAtMs`, and `revision`;
- runtime must tolerate missing `mediaObjects` and treat it as empty/default state;
- старые клиенты должны игнорировать новый раздел состояния без падения.

Команды состояния:

```ts
type MediaObjectCommand =
  | {
      type: 'surface.create-object';
      commandId: string;
      surfaceId: string;
      objectType: string;
      initialState?: unknown;
    }
  | {
      type: 'surface.stop-object';
      commandId: string;
      surfaceId: string;
      objectId: string;
    }
  | {
      type: 'surface.patch-object-state';
      commandId: string;
      surfaceId: string;
      objectId: string;
      expectedRevision: number;
      patch: unknown;
    }
  | {
      type: 'surface.lock';
      commandId: string;
      surfaceId: string;
    }
  | {
      type: 'surface.unlock';
      commandId: string;
      surfaceId: string;
    };
```

Все команды должны включать `participantId` на server-side transport envelope или внутри payload. Проверка прав выполняется в room-state command handling, а UI/runtime checks являются только удобством, не защитой.

## Модель прав

- `surface.create-object`: только `host` / `admin` через permission `surface.create-object`;
- `surface.stop-object`: `host` / `admin`, либо owner только если это явно разрешит политика объекта;
- `surface.patch-object-state`: только active object reducer после проверки `surface.input` и object-specific permission;
- `surface.input`: `member` / `host` / `admin` для input events;
- `surface.lock`: только `host` / `admin`;
- rejected commands must update diagnostics with `blockedReason` and must not mutate room state.

Для M1.3 `surface.lock` / `surface.unlock` допускаются как no-op scaffolding или минимальная server-side модель, но они не входят в критерий закрытия, если не нужны для `surface-test-card`.

## Семантика обновления состояния

Каждое изменение object state проходит через object-specific reducer.

Минимальные требования:

- `MediaObjectInstance` содержит `revision: number`;
- patch command содержит `expectedRevision`;
- server rejects stale or mismatched updates;
- `updatedAtMs` меняется только после принятого reducer update;
- reducer не принимает произвольный `unknown` patch без проверки формы;
- `surface-test-card` поддерживает только команду `increment-click-count`.

Пример patch для тестового объекта:

```ts
type SurfaceTestCardPatch = {
  type: 'increment-click-count';
  inputEventId: string;
};
```

Повторный `inputEventId` не должен увеличивать счетчик дважды.

## Интеграция с M1.2

Runtime routes accepted `SurfaceInputEvent` to the active object on `surfaceId`.

Правила:

- если на surface нет active object, ввод только обновляет debug hit state;
- если active object есть, событие получает controller `handleInput(event)`;
- `objectId` в event должен соответствовать active object;
- M1.2 debug hooks remain test-only compatibility helpers;
- XR ray, teleport, seating, and snap-turn behavior must remain covered by existing tests;
- surface input routing не должен мутировать pose, seating state или room-state напрямую вне command/reducer path.

## Тестовый объект-заглушка

Создать объект:

```text
surface-test-card
```

Он должен:

- отображать цветную карточку или текст;
- принимать клик;
- менять счетчик кликов в состоянии;
- показывать этот счетчик всем участникам.

Состояние тестового объекта:

```ts
type SurfaceTestCardState = {
  clickCount: number;
  lastInputEventId: string | null;
};
```

Это нужно, чтобы проверить ядро без сложности экрана, доски и удаленного браузера.

## Задачи агента

1. Добавить типы медийных поверхностей и медийных объектов.
2. Добавить реестр объектов в среду исполнения.
3. Добавить состояние поверхностей в службу состояния комнаты.
4. Добавить команды создания, остановки и обновления объекта.
5. Добавить базовую поверхность в существующую комнату.
6. Добавить тестовый объект-заглушку.
7. Добавить минимальные host/admin test hooks или простое меню поверхности для ведущего:
   - создать тестовый объект;
   - остановить объект;
   - очистить поверхность.
8. Добавить отладочные данные по поверхностям, объектам, last command и blockedReason.

Порядок работ:

1. Shared types and reducers.
2. Room-state authoritative state and command handling.
3. Runtime read-model/debug state for surfaces and objects.
4. Runtime registry and `surface-test-card` controller.
5. M1.2 input routing into active object.
6. Minimal host/admin UI or test hooks.
7. E2E and staging verification.

## Автоматические проверки

Создать:

```text
tests/e2e/m1-media/media-surface-kernel.spec.ts
```

Проверки:

1. В комнате есть список поверхностей.
2. Ведущий может создать объект `surface-test-card` на поверхности.
3. Гость видит активный объект в отладочных данных.
4. Клик по объекту увеличивает счетчик.
5. Счетчик виден на другом участнике.
6. Остановка объекта очищает поверхность.
7. Выход ведущего не ломает поверхность; объект либо остается в безопасном состоянии, либо останавливается согласно политике.
8. Guest/member cannot create or stop object.
9. Unknown object type is rejected.
10. Creating a second object on occupied surface is rejected.
11. Stop with wrong `objectId` is rejected.
12. Stale patch with wrong `expectedRevision` is rejected.
13. Reload/rejoin sees the same active object and click count.
14. Room without persisted media state still loads with default surface.

Unit-тесты должны покрывать:

- reducer `surface-test-card` accepts only `increment-click-count`;
- duplicate `inputEventId` does not double-count;
- permission matrix for create/stop/patch/lock;
- unknown surface/object/type rejection;
- revision mismatch rejection;
- runtime input routing sends accepted `SurfaceInputEvent` only to active object.

CI/staging checks:

- `pnpm --filter @noah/room-state test`;
- `pnpm --filter @noah/runtime-web build`;
- `pnpm --filter @noah/runtime-web test`;
- `pnpm exec playwright test tests/e2e/m1-media --workers=1`;
- full local `pnpm test:e2e`;
- after deploy: `pnpm test:e2e:staging` and focused `media-surface-kernel` staging run.

## Критерии готовности

Подфаза закрыта, если:

- поверхности являются частью состояния комнаты;
- объект можно создать, остановить и синхронизировать;
- объект получает ввод через общий протокол;
- тестовый объект работает у двух и более участников;
- отладочные данные показывают активные поверхности и объекты;
- автоматические проверки проходят.

M1.3 считается закрытой только после commit/push, CI, Docker Publish, Staging Deploy gate and staging verification on the deployed commit.

## Что не считать готовностью

- Поверхность существует только как визуальная плоскость без состояния.
- Объект создается только локально у одного участника.
- Нет общего реестра типов объектов.
- Ввод объекта не проходит через протокол поверхности.
- Команды создания/остановки проверяются только на клиенте.
- Состояние объекта обновляется произвольным patch без reducer/revision.
- Debug state есть только у локального клиента и не подтверждает синхронизацию между участниками.
