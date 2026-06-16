# M1.9 — протокол расширений для медийных объектов

## Статус

Статус: `done` с 2026-06-10.

Реализованный slice:

- добавлен общий contract для `NoahMediaExtensionManifest`, `MediaObjectDefinition`, capabilities и object `stateKind`;
- built-in объекты `surface-test-card`, `screen-share`, `whiteboard`, `remote-browser` описаны как internal extensions;
- добавлен internal `extension-test-card`, который создается через registry и использует generic `surface-test-card` stateKind без отдельной ветки в room-state reducer;
- disabled и missing-capability demo extensions остаются зарегистрированными в debug snapshot, но недоступны для создания;
- room-state проверяет extension enabled state, declared capabilities и required permissions перед созданием объекта;
- runtime debug показывает registered extensions и доступные object types на выбранной поверхности;
- добавлен focused e2e `tests/e2e/m1-media/extension-protocol.spec.ts`.

Финальный deployed commit: `972e98af1d550b782bb7c91452bbedc8484ccfe7`; implementation commit: `d51ff697f35014a11e91e4d44bff16567fb52d24`.

Verification: focused package checks, root `lint`/`typecheck`/`build`/`test`, focused local `extension-protocol` e2e, CI `27265856141`, Docker Publish `27265856222`, Staging Deploy `27266041607`, and focused staging `extension-protocol` e2e passed. Full local `pnpm run test:e2e` had the known pre-existing `remote-browser-object` media track failures: `92 passed`, `1 skipped`, `4 failed`.

## Цель

Описать формальный протокол, по которому новые медийные объекты могут добавляться без изменения ядра среды исполнения.

В ближайшей версии расширения могут быть только внутренними, то есть созданными в рамках проекта NOAH. Но архитектура должна быть готова к будущим независимым разработчикам.

## Почему это важно

Если доска, трансляция, презентация, удаленный браузер и будущие объекты будут добавляться через правку ядра, проект быстро станет трудно расширять.

Нужен общий протокол:

- как объект объявляет свои возможности;
- какие права ему нужны;
- какие поверхности он поддерживает;
- какие события ввода принимает;
- какие состояния публикует;
- какие медиа-потоки создает или принимает;
- как его тестировать.

## Описание расширения

```ts
type NoahMediaExtensionManifest = {
  id: string;
  version: string;
  displayName: string;
  objectTypes: MediaObjectDefinition[];

  requiredCapabilities: Array<
    | 'surface.render'
    | 'surface.input.pointer'
    | 'surface.input.keyboard'
    | 'room.state.read'
    | 'room.state.write'
    | 'media.publish'
    | 'media.subscribe'
    | 'remote.executor'
  >;

  requiredPermissions: string[];

  compatibility: {
    noahRuntime: string;
    roomManifestSchema: number;
  };

  entry: string;
};
```

## Протокол выполнения объекта

```ts
type NoahMediaExtension = {
  manifest: NoahMediaExtensionManifest;
  createController(ctx: MediaObjectMountContext): Promise<MediaObjectController>;
};
```

## Разрешения и возможности

Расширение не должно получать доступ ко всему ядру.

Оно получает только явно разрешенные возможности:

```ts
type ExtensionRuntimeApi = {
  surface: {
    setTexture(texture: unknown): void;
    setCanvas(canvas: HTMLCanvasElement): void;
    setPlaceholder(message: string): void;
    requestRedraw(): void;
  };

  input: {
    onInput(handler: (event: SurfaceInputEvent) => void): void;
    requestFocus(): void;
  };

  state: {
    getState(): unknown;
    patchState(patch: unknown): Promise<void>;
    onStateChanged(handler: (state: unknown) => void): void;
  };

  media: {
    publishTrack?(track: unknown): Promise<string>;
    subscribeTrack?(trackSid: string): Promise<unknown>;
  };

  permissions: {
    has(permission: string): boolean;
  };
};
```

## Первая стадия безопасности

Для M1-MEDIA не нужно открывать произвольное выполнение кода внешних разработчиков.

Рекомендуемая последовательность:

1. Все объекты реализуются как внутренние расширения, но используют общий протокол.
2. Включается реестр расширений.
3. Добавляется проверка описания расширения.
4. Добавляются возможности и разрешения.
5. Позже добавляется подписанная поставка внешних расширений.
6. Еще позже добавляется изоляция внешнего кода.

## Запрещено в M1-MEDIA

- произвольный пользовательский JavaScript;
- установка расширений из непроверенного источника;
- доступ расширения к глобальным объектам среды исполнения без ограничений;
- прямой доступ расширения к состоянию всех участников;
- прямое управление медиа-транспортом без проверенных возможностей.

## Требования к каждому расширению

Каждое расширение должно иметь:

- описание;
- типы объектов;
- список возможностей;
- список разрешений;
- модульные проверки;
- проверки состояния комнаты;
- проверки отладочных данных;
- сценарий ухудшенного режима.

## Пример описания доски

```json
{
  "id": "noah.whiteboard",
  "version": "0.1.0",
  "displayName": "Interactive Whiteboard",
  "requiredCapabilities": [
    "surface.render",
    "surface.input.pointer",
    "room.state.read",
    "room.state.write"
  ],
  "requiredPermissions": [
    "whiteboard.draw",
    "whiteboard.clear"
  ],
  "compatibility": {
    "noahRuntime": ">=0.1.0",
    "roomManifestSchema": 1
  },
  "entry": "./whiteboard.js"
}
```

## Пример описания трансляции экрана

```json
{
  "id": "noah.screen-share",
  "version": "0.1.0",
  "displayName": "Screen Share Surface",
  "requiredCapabilities": [
    "surface.render",
    "media.publish",
    "media.subscribe",
    "room.state.read",
    "room.state.write"
  ],
  "requiredPermissions": [
    "screen-share.start",
    "screen-share.stop"
  ],
  "compatibility": {
    "noahRuntime": ">=0.1.0",
    "roomManifestSchema": 1
  },
  "entry": "./screen-share.js"
}
```

## Задачи агента

1. Описать протокол расширений в `docs`.
2. Добавить типы описания расширения.
3. Перевести тестовый объект, доску и трансляцию экрана на общий протокол.
4. Добавить проверку описания расширения.
5. Добавить отладочные данные по зарегистрированным расширениям.
6. Добавить тест, что новый тестовый объект можно зарегистрировать без правки ядра.

## Автоматические проверки

Создать:

```text
tests/e2e/m1-media/extension-protocol.spec.ts
```

Проверки:

1. Реестр содержит внутренние расширения.
2. Описание расширения проходит проверку.
3. Расширение без нужной возможности не может создать объект.
4. Расширение без нужного разрешения не может выполнить действие.
5. Тестовое расширение можно зарегистрировать и создать объект на поверхности.
6. Отключенное расширение не доступно в меню поверхности.

## Критерии готовности

Подфаза закрыта, если:

- доска и трансляция экрана работают как расширения через общий протокол;
- новое внутреннее расширение можно добавить без изменения ядра;
- возможности и разрешения проверяются;
- отладочные данные показывают зарегистрированные расширения;
- автоматические проверки проходят.

## Что не считать готовностью

- Протокол описан в документации, но код объектов все равно напрямую вызывает ядро.
- Расширение может получить любые права без объявления возможностей.
- Новая кнопка в меню поверхности требует изменения ядра.
- Нет теста на регистрацию нового объекта.
