# Архитектура интерактивных медийных объектов

## 1. Цель архитектуры

Цель — сделать систему медийных поверхностей расширяемой.

Нужно избежать ситуации, когда каждая новая возможность требует правки ядра среды исполнения. Показ экрана, доска, удаленный браузер, презентация и будущие объекты должны подключаться через единый протокол.

Под **ядром среды исполнения** понимается часть клиентского приложения, которая отвечает за:

- загрузку комнаты;
- трехмерную сцену;
- камеру;
- режимы обычного браузера, телефона и виртуальной реальности;
- ввод пользователя;
- подключение к состоянию комнаты;
- подключение к медиа-транспорту;
- базовый жизненный цикл объектов.

Ядро не должно знать внутреннюю логику каждого медийного объекта. Оно должно знать только общий протокол.

## 2. Основные сущности

### 2.1. Медийная поверхность

Медийная поверхность — это объект сцены, на который можно вывести содержимое.

Минимальные свойства:

```ts
type MediaSurface = {
  surfaceId: string;
  roomId: string;
  anchorId?: string;

  transform: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    roll: number;
  };

  size: {
    widthM: number;
    heightM: number;
  };

  aspectRatio: number;
  inputEnabled: boolean;
  allowedObjectTypes: string[];
  activeObjectId?: string;
  lockedByParticipantId?: string;
};
```

Пояснение:

- `surfaceId` — устойчивый идентификатор поверхности внутри комнаты.
- `transform` — положение и поворот поверхности в комнате.
- `size` — физический размер поверхности в метрах.
- `allowedObjectTypes` — какие типы объектов можно включать на этой поверхности.
- `activeObjectId` — какой объект сейчас прикреплен к поверхности.
- `lockedByParticipantId` — кто сейчас управляет поверхностью, если управление монопольное.

### 2.2. Медийный объект

Медийный объект — функциональная единица, которую можно прикрепить к поверхности.

Примеры:

- `screen-share` — трансляция экрана;
- `whiteboard` — доска;
- `host-web-broadcast` — трансляция веб-содержимого ведущего как видеопотока;
- `remote-browser` — удаленный браузерный объект;
- `image-viewer` — изображение;
- `video-player` — видео.

Минимальные свойства экземпляра:

```ts
type MediaObjectInstance = {
  objectId: string;
  type: string;
  roomId: string;
  surfaceId: string;
  ownerParticipantId?: string;
  state: unknown;
  createdAtMs: number;
  updatedAtMs: number;
};
```

### 2.3. Описание типа медийного объекта

Описание типа сообщает ядру, какие возможности нужны объекту.

```ts
type MediaObjectDefinition = {
  type: string;
  version: string;
  displayName: string;

  capabilities: Array<
    | 'render.video'
    | 'render.canvas'
    | 'input.pointer'
    | 'input.keyboard'
    | 'media.publish'
    | 'media.subscribe'
    | 'state.sync'
    | 'host.only'
    | 'remote.executor'
  >;

  supportedSurfaces: {
    minWidthM?: number;
    minHeightM?: number;
    preferredAspectRatios?: number[];
  };

  defaultState: unknown;
};
```

### 2.4. Протокол ввода поверхности

Все способы ввода должны приводиться к одному виду:

```ts
type SurfaceInputEvent = {
  eventId: string;
  roomId: string;
  surfaceId: string;
  objectId?: string;
  participantId: string;

  source: 'mouse' | 'touch' | 'xr-controller' | 'xr-hand' | 'keyboard';
  kind: 'pointer-down' | 'pointer-move' | 'pointer-up' | 'click' | 'scroll' | 'key-down' | 'key-up';

  uv?: {
    u: number;
    v: number;
  };

  pixel?: {
    x: number;
    y: number;
  };

  button?: 'primary' | 'secondary' | 'middle';
  pressure?: number;
  key?: string;
  text?: string;

  clientTimeMs: number;
  seq: number;
};
```

Пояснение:

- `uv` — нормализованные координаты попадания на поверхность: от `0` до `1` по горизонтали и вертикали.
- `pixel` — координаты внутри объекта после пересчета из `uv` в размер объекта.
- `source` — источник ввода.
- `kind` — тип действия.
- `seq` — порядковый номер события от конкретного участника.

Этот протокол должен использоваться и для мыши, и для касания, и для луча из виртуальной реальности.

## 3. Слои системы

### 3.1. Среда исполнения

Отвечает за:

- отрисовку поверхностей;
- попадание луча или курсора в поверхность;
- пересчет координат попадания в `uv`;
- показ видеотекстур, холста доски и заглушек;
- вызов методов медийных объектов;
- отображение меню поверхности.

Среда исполнения не должна знать, как работает удаленный браузер или как хранится доска. Она знает только протокол.

### 3.2. Служба состояния комнаты

Отвечает за:

- список поверхностей;
- активные объекты на поверхностях;
- роли участников;
- блокировки управления;
- состояние объектов, если оно легкое и подходит для синхронизации через состояние комнаты.

Пример состояния:

```ts
type RoomMediaState = {
  surfaces: Record<string, MediaSurface>;
  objects: Record<string, MediaObjectInstance>;
  surfaceLocks: Record<string, {
    participantId: string;
    expiresAtMs: number;
  }>;
};
```

### 3.3. Слой медиа-транспорта

Отвечает за потоки:

- голос;
- трансляция экрана;
- видеопоток удаленного браузера;
- возможные будущие камеры или видеоматериалы.

Слой медиа-транспорта не должен быть источником истины для состояния объектов. Он передает потоки. Состояние того, какой поток прикреплен к какой поверхности, хранится в состоянии комнаты.

### 3.4. Управляющий слой

Отвечает за:

- авторизацию;
- выдачу ролей;
- политики доступа;
- описание комнаты;
- список доступных медийных объектов;
- включение возможностей для организации или комнаты.

### 3.5. Реестр расширений

Отвечает за:

- регистрацию типов медийных объектов;
- проверку требуемых возможностей;
- включение или отключение объектов на уровне комнаты;
- будущую поддержку независимых разработчиков.

## 4. Жизненный цикл медийного объекта

```text
зарегистрирован тип объекта
        ↓
поверхность разрешает этот тип
        ↓
участник с правами создает экземпляр
        ↓
экземпляр прикрепляется к поверхности
        ↓
объект запускается
        ↓
объект принимает ввод и/или медиа-поток
        ↓
состояние синхронизируется
        ↓
объект останавливается
        ↓
поверхность очищается или получает другой объект
```

Методы жизненного цикла:

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

## 5. Важное разделение: поток и управление

### 5.1. Трансляция экрана

Трансляция экрана — это поток изображения.

Участники смотрят. Поверхность может быть интерактивной для управления самой поверхностью: выбрать, закрепить, масштабировать, остановить. Но клик по картинке не обязан означать клик по веб-странице внутри потока.

### 5.2. Управляемая веб-поверхность

Управляемая веб-поверхность — это объект с исполнителем команд.

Она принимает координаты кликов, прокрутку и клавиатурный ввод, а затем передает их в удаленный браузер или специальную интеграцию.

Поэтому архитектурно это другой тип объекта.

## 6. Политика прав

Минимальные роли:

```ts
type RoomRole = 'guest' | 'member' | 'host' | 'admin';
```

Минимальные разрешения:

```ts
type RoomPermission =
  | 'room.join'
  | 'audio.join'
  | 'surface.view'
  | 'surface.select'
  | 'surface.create-object'
  | 'surface.stop-object'
  | 'surface.lock'
  | 'surface.input'
  | 'screen-share.start'
  | 'screen-share.stop'
  | 'whiteboard.draw'
  | 'whiteboard.clear'
  | 'remote-browser.open-url'
  | 'remote-browser.input'
  | 'room.admin';
```

Пример политики:

```ts
const defaultPolicy = {
  guest: ['room.join', 'audio.join', 'surface.view'],
  member: ['room.join', 'audio.join', 'surface.view', 'surface.input', 'whiteboard.draw'],
  host: [
    'room.join',
    'audio.join',
    'surface.view',
    'surface.select',
    'surface.create-object',
    'surface.stop-object',
    'surface.lock',
    'surface.input',
    'screen-share.start',
    'screen-share.stop',
    'whiteboard.draw',
    'whiteboard.clear'
  ],
  admin: ['room.admin']
};
```

## 7. Отладочные данные

Добавить в `window.__NOAH_DEBUG__` раздел:

```ts
mediaObjects: {
  surfaces: Array<{
    surfaceId: string;
    activeObjectId?: string;
    activeObjectType?: string;
    inputEnabled: boolean;
    selectedByLocalParticipant: boolean;
    lockedByParticipantId?: string;
    visible: boolean;
  }>;

  objects: Array<{
    objectId: string;
    type: string;
    surfaceId: string;
    ownerParticipantId?: string;
    state: 'idle' | 'starting' | 'active' | 'stopping' | 'failed';
    mediaTrackSid?: string;
    lastInputEventSeq?: number;
    lastStateUpdateMs?: number;
  }>;

  input: {
    lastSurfaceHit?: {
      surfaceId: string;
      u: number;
      v: number;
      source: string;
    };
    lastEvent?: SurfaceInputEvent;
  };
}
```

## 8. Автоматизируемость

Для каждого медийного объекта нужны:

- модульные проверки логики;
- проверки протокола ввода;
- проверки состояния комнаты;
- проверки отладочных данных;
- проверки ухудшенных режимов;
- имитация медиа-провайдера там, где реальный захват экрана невозможно надежно автоматизировать.

Финальная ручная проверка нужна только для:

- реального выбора экрана, окна или вкладки;
- реального устройства виртуальной реальности;
- субъективного восприятия удобства управления лучом.

## 9. Нельзя делать в этой фазе

- Нельзя вшивать доску, трансляцию экрана и удаленный браузер напрямую в ядро без общего протокола.
- Нельзя давать произвольному внешнему коду доступ к среде исполнения без проверки возможностей.
- Нельзя считать трансляцию экрана управляемой веб-страницей.
- Нельзя смешивать состояние комнаты и медиа-транспорт.
- Нельзя делать отдельный кодовый путь только для виртуальной реальности.
- Нельзя закрывать фазу без автоматических проверок.
