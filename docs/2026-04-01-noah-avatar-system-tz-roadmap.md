# ТЗ и Roadmap: система аватаров для `noah` (web / VR, stylized social avatars)

## 1. Что проектируем

Нужно внедрить в текущее многопользовательское web/VR-приложение полноценную систему социальных аватаров, визуально и по ощущению похожую на Meta/Oculus social avatars, но без копирования чужих мешей, текстур, шейдеров или SDK-ассетов.

Целевая версия `v1`:

- 10 готовых пресетов аватаров.
- Единый стиль: дружелюбные stylized social avatars, выразительные руки/верх тела, облегчённая, но правдоподобная лицевая анимация.
- Поддержка desktop / mobile / VR в рамках одного runtime.
- В VR руки должны идти за контроллерами; при наличии hand-tracking — использовать его локально как enhancement.
- Губы должны двигаться от живого звука.
- Ноги должны ходить при перемещении.
- Должен существовать режим сидения (`sit`) там, где в сцене есть seat anchors.
- Всё должно быть плавным и естественным в браузере, без деградации room flow.
- Архитектура должна быть совместима с будущей кастомизацией, но кастомизация не входит в обязательный объём `v1`.

## 2. На что опираемся в текущем репозитории

По коду уже есть хорошая база, на которую нужно опираться, а не ломать её:

- `apps/runtime-web` уже работает на `Three.js` и имеет `WebXR` scaffold.
- `apps/runtime-web/src/main.ts` уже синхронизирует coarse presence, умеет интерполировать удалённые позиции (`motion-state.ts`) и рисует простые capsule/sphere-аватары.
- `apps/runtime-web/src/main.ts` уже отправляет presence примерно раз в `80ms` и интерполирует remote samples с буфером около `120ms`.
- `apps/runtime-web/src/voice.ts` и `spatial-audio.ts` уже задают направление для voice / spatial audio.
- `apps/room-state` — это отдельный realtime state plane по WebSocket, то есть аватары можно строить без привязки к media plane.
- `apps/api` уже умеет выдавать manifest и feature flags.
- `scene-loader.ts` уже загружает `glTF/GLB`, но пока без production-grade поддержки сжатых текстур/геометрии для avatar assets.

### Вывод

Система аватаров должна быть отдельной подсистемой внутри текущего `runtime-web`, с отдельными типами, транспортом и quality profiles, но без пересборки всей архитектуры проекта.

---

## 3. Главные архитектурные решения

### 3.1. Не интегрировать Meta Avatar SDK напрямую

Для текущего репозитория не надо планировать прямую интеграцию Meta Avatar SDK как продуктовой основы, потому что текущий проект — это `Three.js + WebXR + browser runtime`, а не Unity/Quest native runtime. Правильный путь здесь — **собственная avatar subsystem**, построенная по тем же принципам, что у Meta social avatars: локальная оценка позы + потоковая передача позы удалённым участникам + адаптивная интерполяция на принимающей стороне.

### 3.2. Не делать аватары зависимыми от `Join Audio`

Позы аватаров, выбор аватара, состояние сидения и жесты **не должны зависеть** от того, подключился ли пользователь к голосу.

Причина:
- в текущем продукте voice join — отдельное пользовательское действие;
- presence уже отделён от media plane;
- если привязать pose sync к LiveKit-соединению, то визуальная часть room flow перестанет работать у пользователя без `Join Audio`.

**Итоговое решение:**
- authoritative / reliable avatar state идёт через `room-state`;
- high-frequency pose stream в `v1` идёт через тот же realtime state transport;
- LiveKit data channel может быть добавлен позже как optional optimization, но не как обязательное условие работы аватаров.

### 3.3. Передавать по сети только то, что действительно нужно

Нельзя синхронизировать “всё тело по костям каждый кадр”. Для web это слишком дорого по сети и по CPU.

**Передаём по сети в `v1`:**
- `root` (позиция + yaw + скорость),
- `head` (позиция + ориентация),
- `leftHand` / `rightHand` (позиция + ориентация),
- hand gesture state,
- locomotion state,
- reliable state: `avatarId`, `seated`, `seatId`, mute/media flags.

**Не передаём по сети в `v1`:**
- полный скелет;
- отдельные кости ног;
- viseme weights;
- полные `XRHand` joint arrays;
- готовый `bodyTransform`.

`body`, `pelvis`, `spine`, `legs`, `feet` должны вычисляться локально на каждом клиенте через lightweight IK / locomotion solver.

### 3.4. Липсинк делать локально от того аудио, которое реально слышит клиент

Для удалённых пользователей рот должен двигаться **не от сетевых viseme packets**, а от анализа приходящего аудио на клиенте.

Плюсы:
- нет дополнительного сетевого трафика;
- рот двигается синхронно именно с тем аудио, которое реально слышит конкретный клиент;
- не нужен отдельный server-side viseme pipeline;
- легче выдержать web budget.

### 3.5. Один мастер-риг для всех 10 аватаров

Все `10` пресетов должны быть построены на **одном и том же humanoid rig / skeleton layout**.

Это обязательное ограничение.

Что это даёт:
- один animation graph;
- один набор IK solver rules;
- один сетевой pose format;
- отсутствие runtime retargeting между разными ригами;
- предсказуемая производительность;
- лёгкий переход к кастомизации через `AvatarRecipe`, а не через разные incompatible модели.

### 3.6. Для `v1` — stylized full-body через 3-point/5-point body solve, а не full-body mocap

Основа аватара в VR:

- `head`
- `leftHand`
- `rightHand`
- `root`
- плюс производные: скорость, yaw, locomotion mode, seated state

Из этого локально восстанавливаются:
- pelvis / hips,
- spine,
- chest rotation,
- legs,
- foot planting.

То есть делаем **убедительный full-body inference**, а не pretend full-body tracking.

### 3.7. Аватарные ассеты — только `GLB`, без `FBX` в runtime path

Для production path аватаров:

- формат ассетов: только `GLB`
- обязательный сжатый pipeline
- никакого runtime-import `FBX` для avatar assets

`FBX` допустим только как источник на этапе контент-пайплайна, но не как формат runtime delivery.


### 3.8. Явно отвергнутые альтернативы для `v1`

#### 1. Прямой Meta Avatar SDK как core runtime dependency
Отклонено: не совпадает с текущим `Three.js/WebXR` product path.

#### 2. Pose sync через LiveKit как единственный transport
Отклонено: нарушает разделение state/media plane и делает visual presence зависимой от voice join.

#### 3. Полный networked skeleton / networked legs / networked visemes
Отклонено: слишком дорого для web по bandwidth, CPU и сложности синхронизации.

#### 4. Полный `XRHand` joint streaming
Отклонено: hand-tracking в вебе нельзя считать универсально доступным baseline, а payload слишком велик для `v1`.

#### 5. Runtime retargeting между разными ригами
Отклонено: неоправданно усложняет pipeline и ломает предсказуемость performance.

---

## 4. Границы `v1` и `v2`

## `v1` (обязательный объём)

- 10 пресетов.
- Единый риг.
- Локальный self-avatar.
- Remote avatars.
- Head + hands sync.
- Лёгкий hand gesture system.
- Walk / strafe / backpedal / turn-in-place.
- Sit / stand.
- Audio-driven mouth.
- Quality profiles и LOD.
- Production-safe fallback в capsule avatars.

## `v2` (после `v1`, не блокирует запуск)

- Кастомизация по слотам (`hair`, `outfit`, `skin`, `palette`, `accessories`).
- Дополнительные эмоции / emotes.
- Более точный hand-tracking для remote near avatars.
- Optional lossy RTC data path.
- Более сложный viseme mapping.
- Persisted user avatar profile через control-plane.


## 4.1. Целевая вместимость и границы проверки

Чтобы не смешивать “количество пресетов” и “количество участников”, фиксируем два независимых параметра.

### Каталог

- `10` пресетов аватаров в `v1`.

### Realtime room target для avatar subsystem

- обязательная приёмка: `2-4` участника одновременно (в соответствии с текущим M0 контекстом репозитория);
- архитектурный запас `v1`: до `8` remote avatars при включённых LOD и quality caps;
- всё, что выше, допускается только как best-effort с более агрессивной деградацией.

### Условия валидности метрик

Все perf/SLO цели ниже считаются валидными только если одновременно выполнены условия:

- сцена находится в рамках content budgets;
- avatar pack прошёл CI budget checks;
- комната не перегружена сторонними тяжёлыми scene assets;
- включён соответствующий quality profile (`desktop-standard`, `xr`, `mobile-lite`).

---

## 5. Функциональные требования (`FR`)

| ID | Требование | Критерий приёмки |
|---|---|---|
| FR-01 | Пользователь может выбрать один из 10 пресетов аватара | В join flow или profile UI доступно 10 вариантов; выбор сохраняется на сессию |
| FR-02 | Локальный аватар отображается в комнате | В desktop/mobile/VR локальный пользователь видит свои руки/тело согласно режиму self-visibility |
| FR-03 | Удалённые участники видят выбранный пресет и его состояние | В двух клиентах аватар, имя, mute/speaking state и seated state совпадают |
| FR-04 | Голова и руки синхронизируются между участниками | При движении HMD/контроллеров remote avatar плавно повторяет pose |
| FR-05 | Ноги автоматически переходят в idle/walk/strafe/backpedal/turn | При движении root legs анимируются без заметного foot skating в пределах бюджета |
| FR-06 | При звуке рот двигается | Self-avatar и remote avatars открывают рот по аудио; при mute рот закрывается |
| FR-07 | Пользователь может сесть и встать | При наличии seat anchor пользователь садится/встаёт, состояние синхронизируется всем |
| FR-08 | Система работает без зависимости от `Join Audio` | Без voice join видны аватары и их позы; только lipsync не активен без audio stream |
| FR-09 | Система корректно деградирует | При нехватке производительности включаются LOD / отключаются дорогие эффекты / fallback к capsules |
| FR-10 | Система выдерживает reconnect / late join | После reconnect remote avatars восстанавливаются без “сломанного” скелета и без дублирования |
| FR-11 | Аватары работают в built-in fallback room и в scene bundles | Если сцена не содержит seat anchors/navmesh, система продолжает работать без sit-specific UI |
| FR-12 | Система готова к кастомизации | Появляется `AvatarRecipe`/`avatarId` contract, не завязанный на hardcoded mesh names в `main.ts` |

---

## 6. Нефункциональные требования (`NFR`)

### 6.1. Производительность

| ID | Требование | Целевое значение |
|---|---|---|
| NFR-01 | XR profile должен оставаться плавным при соблюдении content budgets | Целевой baseline: `72 FPS` в XR-friendly room; если бюджет превышен — автоматическая деградация, а не лаги |
| NFR-02 | Desktop profile | `60 FPS` target в default room при 4 remote avatars |
| NFR-03 | Mobile-lite profile | `30 FPS` target в default room при 3 remote avatars |
| NFR-04 | Avatar subsystem не должен съедать основную часть кадра | В XR-профиле вклад аватарной подсистемы в CPU/GPU budget должен быть ограничен и измеряем |
| NFR-05 | Remote avatar update должен быть ограничен по стоимости | Дорогой IK / lipsync / fingers не запускаются на всех remote avatars одновременно |

### 6.2. Сеть и синхронизация

| ID | Требование | Целевое значение |
|---|---|---|
| NFR-06 | High-frequency pose stream должен быть компактным | Целевой размер бинарного pose frame: `<= 64 bytes`, верхний лимит `<= 128 bytes` |
| NFR-07 | Частота pose updates должна быть адаптивной | VR: `30 Hz` baseline, degrade floor: `20 Hz`; desktop/mobile: `10 Hz` baseline, с понижением при перегрузе |
| NFR-08 | Рендер должен идти через interpolation buffer | Базовая playback delay: `100-140ms`, адаптивная по фактическому jitter |
| NFR-09 | Out-of-order и stale packets не должны ломать pose | Пакеты с устаревшим `seq` дропаются; stale extrapolation ограничена по времени |
| NFR-10 | Authoritative state не должен теряться | `avatarId`, `seated`, `seatId`, `mute`, `inputMode` идут по reliable path |

### 6.3. Совместимость и отказоустойчивость

| ID | Требование | Целевое значение |
|---|---|---|
| NFR-11 | Feature detection обязателен | Hand tracking, XR, lipsync, seats, high-quality LOD включаются только если среда их реально поддерживает |
| NFR-12 | Fallback обязателен | При ошибке asset load / budget overflow / runtime incompatibility — откат в capsule avatars |
| NFR-13 | Никакой критичной логики в монолитном `main.ts` | Avatar system выносится в отдельные модули |
| NFR-14 | Наблюдаемость обязательна | Диагностика по FPS, LOD, pose jitter, packet age, fallback reasons, seat conflicts |


### 6.4. Дополнительные SLO / budgets, которые надо реально измерять

#### End-to-end visual latency

- remote hands/head visual lag:
  - target `p50 <= 150ms`
  - upper bound `p95 <= 220ms`
- mouth motion relative to **слышимому** audio:
  - target `<= 1-2 render frames`
- authoritative seat claim / release:
  - target `<= 300ms` при нормальной сети

#### Вклад avatar subsystem в frame budget

Ниже — не “абсолютная правда для любой сцены”, а жёсткие целевые лимиты для приемки в room, которая сама находится в content budget.

| Profile | CPU p95 budget для avatar subsystem | GPU p95 budget для avatar subsystem |
|---|---:|---:|
| `xr` | `<= 3.5ms` | `<= 2.5ms` |
| `desktop-standard` | `<= 3.0ms` | `<= 2.0ms` |
| `mobile-lite` | `<= 2.0ms` | `<= 1.5ms` |

#### Критерии деградации

Если subsystem держится выше этих лимитов дольше скользящего окна, runtime обязан:

1. понизить LOD;
2. сократить число expensive avatars;
3. уменьшить lipsync / IK frequency;
4. при необходимости откатиться к proxy/capsule mode.

---

## 7. Визуальный и контентный стандарт аватаров

## 7.1. Художественное направление

Требование к стилю:

- не photoreal;
- не toy/cartoon;
- stylized social realism;
- мягкие пропорции;
- читаемые руки;
- чистые, простые материалы;
- выраженная мимика рта/век;
- хороший силуэт с расстояния;
- ощущение “social VR avatar” в духе Meta, но с собственной визуальной библиотекой.

## 7.2. Контентный набор `v1`

Набор `v1`:

- `10` пресетов;
- общая skeleton layout;
- вариативность достигается через:
  - head variant,
  - body variant,
  - hair variant,
  - outfit variant,
  - palette tokens,
  - optional accessories;
- каждая сборка должна оставаться совместимой с тем же animation graph.

## 7.3. Обязательные анимации / позы

Минимальный анимационный пакет:

- `idle`
- `walk_forward`
- `strafe_left`
- `strafe_right`
- `backpedal`
- `turn_in_place_left`
- `turn_in_place_right`
- `sit_idle`
- `sit_enter`
- `sit_exit`
- `gesture_relaxed`
- `gesture_point`
- `gesture_fist`
- `gesture_pinch`
- `gesture_thumbs_up` (опционально)
- `blink_idle`

## 7.4. Обязательные morph targets лица для `v1`

Минимум:

- `blinkLeft`
- `blinkRight`
- `jawOpen`
- `mouthWide`
- `mouthRound`

Опционально, если бюджет позволяет:

- `browInnerUp`
- `smileSoft`

## 7.5. Жёсткие asset budgets

### Общие ограничения для avatar pack

- один master rig;
- один animation library;
- один `avatar catalog`;
- no FBX in runtime;
- `GLB` only;
- shared texture atlases where possible.

### Геометрия

| LOD | Назначение | Triangle budget |
|---|---|---|
| L0 | self / nearest avatars | `<= 15k` tris |
| L1 | mid distance remote | `<= 8k` tris |
| L2 | far remote | `<= 2k` tris или simplified upper-body variant |
| L3 | emergency fallback | capsule/simple proxy |

### Материалы и меши

- `<= 2` skinned meshes на аватар для `L0`
- `<= 2` materials на аватар для `L0`
- `<= 1` material на avatar для `L1/L2` по возможности
- аксессуары без самостоятельных material islands, если можно положить в atlas
- прозрачность/alpha clip — только там, где без неё нельзя (например, часть hair cards)

### Текстуры

- self / near avatars: базовая целевая текстурная схема — компактная, с atlas-подходом;
- remote avatars не должны грузить уникальные текстуры на каждого участника;
- обязательное сжатие текстур в `KTX2/Basis`;
- для mobile-lite допускается упрощённый комплект текстур.

### Риг

- единый humanoid rig;
- верхняя граница deform bones для `v1`: `<= 65`;
- не передавать по сети кости ног, spine и fingers поштучно;
- любые дополнительные facial bones в `v1` не требуются.

---

## 8. Форматы данных и контракты

## 8.1. Новый слой типов

Ввести отдельные типы в `packages/shared-types`, не раздувая старый coarse `PresenceState` до состояния “всё в одном”.

### 8.1.1. Reliable avatar state

```ts
export type AvatarInputMode =
  | "desktop"
  | "mobile"
  | "vr-controller"
  | "vr-hand";

export interface AvatarReliableState {
  participantId: string;
  avatarId: string;           // preset-01 ... preset-10
  recipeVersion: 1;
  inputMode: AvatarInputMode;
  seated: boolean;
  seatId?: string;
  muted: boolean;
  audioActive: boolean;
  updatedAt: string;
}
```

### 8.1.2. Pose frame (`transient`, high-frequency)

```ts
export interface CompactPoseFrame {
  seq: number;
  sentAtMs: number;
  flags: number;

  root: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    vx: number;
    vz: number;
  };

  head: {
    x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
  };

  leftHand: {
    x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
    gesture: number;
  };

  rightHand: {
    x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
    gesture: number;
  };

  locomotion: {
    mode: number;     // idle/walk/strafe/backpedal/turn/sit
    speed: number;
    angularVelocity: number;
  };
}
```

## 8.2. Почему `bodyTransform` не должен быть сетевым источником правды

Текущее coarse state уже имеет `bodyTransform`, но для avatar system это не должен быть основной authoritative payload.

Причина:
- тело должно строиться локально из `root + head + hands + locomotion`;
- если передавать уже вычисленный `bodyTransform`, будет тяжелее корректно строить ноги и spine;
- body solve должен быть единообразным на клиентах.

**Решение:**
- coarse `bodyTransform` можно сохранить для legacy presence/debug;
- avatar runtime должен опираться на `root/head/hands`.

## 8.3. `AvatarRecipe` для будущей кастомизации

```ts
export interface AvatarRecipeV1 {
  schemaVersion: 1;
  avatarId: string;
  rig: "humanoid-v1";
  bodyVariant: string;
  headVariant: string;
  hairVariant: string;
  outfitVariant: string;
  palette: {
    skin: string;
    primary: string;
    accent: string;
  };
  accessories: string[];
}
```

В `v1` пресеты жёстко заданные, но внутренняя модель данных сразу должна быть recipe-based.

---

## 9. Синхронизация и transport design

## 9.1. Разделение на reliable и transient каналы

### Reliable path

Используется для событий и состояния, которое должно дойти:

- join / leave
- avatar selection
- seated / unseated
- seat claim / release
- mute / audioActive flags
- feature negotiation
- snapshot for late join

### Transient high-frequency path

Используется только для pose:

- root
- head
- left/right hand
- locomotion state
- hand gestures

**Правило:** никакие high-frequency pose updates не должны блокировать reliable state.

## 9.2. Транспорт в `v1`

### Обязательное решение

В `v1` pose sync строится на текущем `room-state` realtime transport, расширенном до двух видов сообщений:

1. reliable JSON messages
2. binary pose frames (`ArrayBuffer`)

### Почему так

- работает независимо от voice join;
- укладывается в текущую архитектуру runtime / room-state;
- даёт управляемую эволюцию к будущему Colyseus-room layer;
- не требует перепроектирования media plane.

### Жёсткое ограничение

Серверный `room-state` не должен JSON-парсить каждый high-frequency pose frame. Для pose path нужен бинарный формат и fast relay.

## 9.3. Optional optimization path (не блокирует `v1`)

Если после профилирования станет видно, что TCP/WebSocket head-of-line blocking ухудшает remote hand smoothness в более крупных комнатах, допускается **второй этап**:

- authoritative state остаётся в `room-state`
- transient pose stream переезжает в lossy data channel / RTC path

Но это **последующий optimization phase**, а не обязательная часть базового запуска.

## 9.4. Правила отправки pose

### Частота

- VR: `30 Hz` baseline
- Desktop/mobile: `10 Hz` baseline
- При перегрузе: VR не ниже `20 Hz`; desktop/mobile: `8 Hz`
- Ни при каких условиях не слать полный pose каждый render frame

### Threshold-based send

Пакет отправляется, если выполнено любое условие:

- прошло `50ms` с предыдущей отправки (VR) или `100ms` (desktop/mobile)
- `root` сдвинулся более чем на `2cm`
- `head` сдвинулся более чем на `1.5cm`
- `hand` сдвинулась более чем на `1.5cm`
- yaw изменился более чем на `2°`
- изменился `gesture`
- изменился `locomotion mode`


### Целевой binary packet layout для `CompactPoseFrame`

Цель `v1` — держать нормальный transient pose frame в пределах `64 bytes`, а не “сотни байт JSON на каждое движение руки”.

| Поле | Байты | Комментарий |
|---|---:|---|
| `seq` | 2 | `uint16` |
| `flags` | 1 | bitset |
| `locomotionMode` | 1 | enum |
| `sentAtMs` | 4 | `uint32` |
| `root.position` | 6 | `x,y,z` как `int16` в сантиметрах |
| `root.yaw` | 2 | `int16` |
| `root.velocity` | 4 | `vx,vz` как `int16` |
| `head.position` | 6 | `int16` |
| `head.rotation` | 8 | compact quaternion |
| `leftHand.position` | 6 | `int16` |
| `leftHand.rotation` | 8 | compact quaternion |
| `leftHand.gesture` | 1 | enum |
| `rightHand.position` | 6 | `int16` |
| `rightHand.rotation` | 8 | compact quaternion |
| `rightHand.gesture` | 1 | enum |

**Итого:** `64 bytes`.

Допустимый расширенный пакет для будущего richer hand-curl режима — до `<= 128 bytes`, но это не должно становиться базовым path для всех участников.

### Правила квантования

- координаты квантуются в сантиметрах;
- yaw / quaternion components квантуются в `int16`;
- при декодировании обязательны clamp и validation checks;
- любые некорректные значения дропаются до попадания в pose buffer.

### Серверный relay policy

- latest-wins
- out-of-order frame discard по `seq`
- rate limit per participant
- packet size limit
- NaN / Inf / absurd coordinates -> drop + diagnostics
- при overload сервер имеет право дропать промежуточные transient frames, но не reliable state

## 9.5. Interpolation / jitter buffer на клиенте

На remote render path:

- отдельный pose ring buffer на каждого remote avatar
- базовый playback delay: `120ms`
- адаптивный диапазон: `80-160ms`
- interpolation по времени, а не по индексу пакета
- короткая extrapolation допускается только для:
  - `root` — до `80ms`
  - `head/hands` — до `50ms`
- если данных нет дольше порога — avatar “замораживается” в последней корректной позе, а не начинает дёргаться

## 9.6. Late join / reconnect

При late join новый клиент должен сразу получить:

- список участников,
- `AvatarReliableState`,
- последний известный pose frame каждого участника,
- seat occupancy snapshot.

При reconnect локальный клиент должен:

- повторно опубликовать свой reliable state,
- сбросить локальный `seq`,
- пересоздать pose stream,
- не дублировать визуальную сущность того же participantId.

---

## 10. Body solve, руки, ноги, сидение

## 10.1. Self-avatar modes

### VR

- голова скрывается для self-view, чтобы не было camera clipping;
- руки и предплечья видимы;
- тело ниже шеи можно показывать частично (при взгляде вниз / в зеркале);
- mirrors/debug camera могут показывать полный аватар.

### Desktop / mobile

- head/camera синхронизируется;
- руки в `v1` строятся процедурно относительно torso/chest anchor;
- жесты определяются состоянием взаимодействия (`idle`, `point`, `interact`);
- remote viewers всё равно видят целостный аватар.

## 10.2. Руки

### VR controllers

Использовать:
- controller grip pose как wrist anchor
- button/trigger/grab state -> gesture preset

Набор hand presets в `v1`:

- relaxed
- point
- fist
- pinch
- grip
- thumbs-up (optional)

### Hand tracking

Поддержка hand tracking в `v1` — enhancement path:

- использовать только если среда реально поддерживает `hand-tracking`
- локально можно читать `XRHand` / joint poses
- по сети в `v1` не отправлять полный joint array
- на remote side отправлять:
  - wrist pose
  - compact gesture / optional 5-finger curl extension только для near avatars в будущем

## 10.3. Верх тела

Upper body solve:

- pelvis position оценивается от `root`
- chest/spine наклоняются к `head`
- clavicle/shoulders следуют за руками с damped offsets
- arms решаются через two-bone IK к wrist targets

## 10.4. Ноги и локомоция

### Что считается источником истины

Ноги НЕ синхронизируются напрямую.

Источники:
- root position / velocity
- head orientation
- locomotion mode
- seated flag

### State machine locomotion

Минимальные состояния:

- `idle`
- `walk`
- `strafe_left`
- `strafe_right`
- `backpedal`
- `turn_in_place_left`
- `turn_in_place_right`
- `sit`

### Переходы

- `idle -> walk`, если speed > threshold
- `walk -> idle`, если speed < threshold
- `walk -> strafe`, если lateral component доминирует
- `walk -> backpedal`, если движение назад относительно facing
- `idle -> turn_in_place`, если angular velocity высокая без линейного движения
- любое -> `sit`, если authoritative seat state активен

### Foot placement

В `v1`:

- near avatars: упрощённый foot planting / ground alignment
- far avatars: clip-based legs без дорогого foot IK

### Ограничение

Если сцена не даёт корректный floor probe / collision surface, ноги работают в flat-ground режиме по `spawn floor Y`.

## 10.5. Сидение

Сидение — только authoritative feature.

### Seat model

В сцене вводятся seat anchors:

```json
{
  "interactionAnchors": {
    "seats": [
      {
        "id": "chair-01",
        "position": { "x": 1.2, "y": 0, "z": -3.4 },
        "rotationY": 3.14159,
        "hipHeight": 0.46
      }
    ]
  }
}
```

### Поведение

- пользователь отправляет reliable `seat_claim`
- сервер проверяет, свободно ли место
- если место свободно — фиксирует occupant и рассылает authoritative state
- клиент плавно садится за `150-250ms`
- locomotion disabled while seated
- head/hands продолжают жить в реальном времени
- `stand` работает только как release текущего seat

### Конфликты

- один seat — один occupant
- победитель определяется сервером
- проигравшему клиенту UI показывает отказ без локального fake-sit

---

## 11. Липсинк и expressive layer

## 11.1. `v1` lipsync strategy

`v1` не использует speech-to-phoneme и не требует облачной транскрипции.

Используем:

- `AnalyserNode` на local mic path для self-avatar
- `AnalyserNode` на remote audio element path для remote avatars

### Почему это правильно

- минимальный CPU / network overhead
- рот синхронен именно с тем звуком, который слышит клиент
- легко встроить в уже существующую spatial audio graph

## 11.2. Mapping в morphs

Минимальный mapping:

- RMS / amplitude -> `jawOpen`
- low-mid / high-mid ratio -> `mouthRound` / `mouthWide`
- smoothing envelope обязателен
- silence gate обязателен
- при `mute` или отсутствии активного audio track рот стремится в neutral

### Update frequency

- lipsync update loop: `20-30 Hz`
- не обновлять morphs на каждом XR frame, если это не даёт визуальной пользы

## 11.3. Idle expressiveness

Чтобы лицо не было “мертвым” даже без face tracking:

- soft blink timer
- tiny idle noise на head/neck
- optional micro-breathing в chest/root offsets

Эти эффекты:
- не сетевые;
- чисто локальные;
- отключаемые на far LOD.

---

## 12. Качество, LOD и graceful degradation

## 12.1. LOD matrix

### LOD L0 — self / nearest social focus

- full rig
- full upper-body IK
- active lipsync
- nearest quality mesh
- all required morphs
- more frequent pose smoothing

### LOD L1 — near remote

- full upper-body IK
- simplified legs / foot planting
- lipsync active
- simplified materials
- reduced hand detail

### LOD L2 — far remote

- simplified locomotion
- no expensive foot IK
- no detailed hand curls
- optional only `jawOpen`
- lower update importance

### LOD L3 — emergency / overload

- current capsule/proxy avatar
- name label + mute/speaking state
- no advanced rig

## 12.2. Quality profiles

### `desktop-standard`

- near avatars in `L0/L1`
- remote cap higher
- richer materials допустимы

### `xr`

- агрессивнее включается LOD
- fewer simultaneous high-cost remote avatars
- foveation / framebuffer scale tuning
- lipsync count and IK count capped

### `mobile-lite`

- no expensive foot IK
- no detailed fingers
- fewer active lipsync avatars
- simplified meshes/materials

## 12.3. Ограничения по количеству “дорогих” аватаров

Жёсткие caps для `v1`:

- `self`: всегда highest local quality
- `XR`: максимум `2` remote avatars с full expensive IK + lipsync одновременно
- `desktop-standard`: максимум `3-4`
- остальные идут в более дешёвые LOD

## 12.4. Triggers для деградации

Переключение на более дешёвый LOD при любом из условий:

- sustained frame budget breach
- scene complexity above threshold
- too many concurrent remote avatars
- mobile-lite mode
- asset load failure
- XR profile under load

**Важно:** деградация должна происходить мягко и предсказуемо, без “дерганья” между режимами. Нужен hysteresis.

---

## 13. Asset pipeline и runtime loading

## 13.1. Production format

Для avatar assets:

- `GLB`
- `EXT_meshopt_compression` — основной geometry/animation compression
- `KHR_texture_basisu` — обязательный texture compression
- `KHR_draco_mesh_compression` — допустим только как compatibility fallback для неидеальных входных ассетов, но не как основной golden path

## 13.2. Почему именно так

- `meshopt` хорошо подходит для web-delivery и работает не только с geometry, но и с animation/morph-related buffer data;
- `KTX2/Basis` нужен для снижения размера передачи и GPU memory footprint;
- `GLTFLoader` уже поддерживает `MeshoptDecoder`, `KTX2Loader` и `DRACOLoader`, значит это естественное развитие текущего `scene-loader.ts`.

## 13.3. Структура runtime-ресурсов

Рекомендуемая структура:

```text
public/assets/avatars/
  catalog.v1.json
  avatar-pack.v1.glb
  avatar-recipes.v1.json
  thumbs/
    preset-01.webp
    ...
    preset-10.webp
```

### Почему pack, а не 10 отдельных GLB

Для `v1` лучше грузить **один shared pack**, а не 10 независимых GLB:

- меньше network round-trips
- единый animation library
- единый rig
- проще контролировать memory budget
- проще шарить geometry/material resources между инстансами

## 13.4. Loader changes

Нужно доработать `scene-loader.ts`/avatar loader так, чтобы:

- инициализировался `KTX2Loader`
- подключался `MeshoptDecoder`
- `DRACOLoader` был доступен как fallback
- avatar assets валидировались до инстанцирования
- ошибка загрузки конкретного пресета не ломала room flow целиком

## 13.5. Валидация pipeline

В `packages/asset-pipeline` добавить:

- avatar-asset validator
- triangle/material/texture budget checks
- required morph target checks
- required animation clip checks
- rig compatibility check
- “same skeleton signature” check for all presets
- CI gate на avatar pack

---

## 14. Изменения в runtime codebase

## 14.1. Что обязательно вынести из `main.ts`

Нельзя развивать avatar system прямо внутри текущего монолита `apps/runtime-web/src/main.ts`.

Нужна новая структура:

```text
apps/runtime-web/src/avatar/
  avatar-types.ts
  avatar-catalog.ts
  avatar-loader.ts
  avatar-instance.ts
  avatar-registry.ts
  avatar-reliable-state.ts
  avatar-pose-codec.ts
  avatar-pose-buffer.ts
  avatar-transport.ts
  avatar-controller.ts
  avatar-ik.ts
  avatar-locomotion.ts
  avatar-lipsync.ts
  avatar-seating.ts
  avatar-lod.ts
  avatar-debug.ts
```

## 14.2. Обязательные модификации существующих модулей

### `apps/runtime-web`

- `main.ts` — orchestration only
- `room-state-client.ts` — поддержка binary pose frames + reliable avatar messages
- `xr.ts` — расширение feature detection для hand-tracking capabilities
- `voice.ts` / `spatial-audio.ts` — интеграция analyser nodes
- `scene-loader.ts` — `KTX2Loader + MeshoptDecoder + DRACOLoader`

### `apps/room-state`

- отдельные room events для avatar reliable state
- binary pose relay path
- seat occupancy model
- rate limiting / packet validation / diagnostics

### `apps/api`

- manifest feature flags:
  - `avatars`
  - `avatarCatalogUrl`
  - `avatarQualityProfile`
  - `avatarSeatsEnabled`
- versioned manifest additions

### `packages/shared-types`

- `avatar.ts`
- `avatar-recipe.ts`
- `avatar-transport.ts`

### `packages/asset-pipeline`

- avatar validator
- asset budget policy
- avatar pack checks

---

## 15. Feature flags

Обязательные feature flags:

- `avatarsEnabled`
- `avatarPoseBinaryEnabled`
- `avatarLipsyncEnabled`
- `avatarLegIKEnabled`
- `avatarSeatingEnabled`
- `avatarCustomizationEnabled`
- `avatarTransportRtcExperimental` (future)
- `avatarFallbackCapsulesEnabled`

Правило rollout:

- каждая тяжёлая часть включается отдельно;
- full rollback возможен до простых capsule avatars без ломания всего runtime.

---

## 16. Метрики, диагностика, observability

Минимальный набор runtime-метрик:

- `avatar.activeCount`
- `avatar.lod.countByTier`
- `avatar.pose.sendHz`
- `avatar.pose.receiveHz`
- `avatar.pose.packetBytes`
- `avatar.pose.packetDrops`
- `avatar.pose.staleMs`
- `avatar.pose.jitterMs`
- `avatar.ik.cpuMs`
- `avatar.lipsync.cpuMs`
- `avatar.frame.cpuContributionMs`
- `avatar.frame.gpuContributionMs`
- `avatar.asset.loadMs`
- `avatar.asset.failureReason`
- `avatar.seat.claimConflictCount`
- `avatar.fallback.reason`

Куда складывать:

- использовать уже существующий diagnostics path в API;
- плюс runtime debug panel.

---

## 17. Критические запреты

Это важно зафиксировать как часть ТЗ.

### Запрещено в `v1`

- использовать Meta SDK assets/meshes/textures как исходник продукта;
- строить сеть на “полный скелет каждый кадр”;
- посылать viseme weights по сети;
- делать аватары обязательным следствием voice join;
- грузить avatar runtime assets как `FBX`;
- продолжать наращивать avatar logic внутри одного `main.ts`;
- запускать одинаково дорогой IK/lipsync для всех remote avatars без caps и LOD.

---

## 18. Фазы реализации (Roadmap)

Ниже фазы устроены так, чтобы каждая следующая зависела от предыдущей, но каждая завершённая фаза была самостоятельной, проверяемой и потенциально готовой к демонстрации.

---

# Phase 0 — Контракты, ассеты, каркас подсистемы

## Цель

Подготовить контрактную и техническую основу так, чтобы дальнейшая работа шла не в монолите и не на временных форматах данных.

## Что входит

- Ввести `AvatarReliableState`, `CompactPoseFrame`, `AvatarRecipeV1`.
- Завести `apps/runtime-web/src/avatar/*`.
- Подготовить `avatar catalog` и `avatar recipe` contracts.
- Договориться о `10` пресетах и едином `humanoid-v1` rig.
- Подключить `KTX2Loader`, `MeshoptDecoder`, `DRACOLoader` в avatar asset path.
- Добавить feature flags.
- Вынести avatar-related debug UI.

## Что не входит

- networking pose sync
- lipsync
- legs
- seating

## Изменяемые модули

- `packages/shared-types`
- `packages/asset-pipeline`
- `apps/runtime-web/src/avatar/*`
- `apps/runtime-web/src/scene-loader.ts`
- `apps/api/src/index.ts` (manifest feature flags)

## Definition of Done

Фаза завершена, если:

1. В репозитории есть отдельные avatar types и runtime modules.
2. Runtime умеет загрузить avatar pack и локально отрисовать все 10 пресетов в sandbox/debug режиме.
3. Каждый пресет валидируется pipeline check'ами:
   - rig compatible
   - morphs present
   - required clips present
   - budgets not exceeded
4. Включение/выключение аватаров делается feature flag’ом.
5. При ошибке загрузки runtime откатывается в capsule avatars.

## Тесты

### Unit

- schema validation для `AvatarReliableState`
- schema validation для `AvatarRecipeV1`
- loader init tests
- validator budget tests

### Manual

- открыть sandbox scene
- переключить все 10 пресетов
- убедиться, что load failure одного пресета не валит остальные

### Артефакты выхода из фазы

- `avatar catalog v1`
- `avatar recipe schema v1`
- `avatar pack validation CI`

---

# Phase 1 — Локальный self-avatar и локальный body solve

## Цель

Появляется полноценный self-avatar в runtime без сети.

## Что входит

- инстанцирование выбранного локального аватара в реальной комнате
- self-visibility rules для VR / desktop / mobile
- local head/root tracking
- controller-based hand mapping
- базовый upper-body solve
- локальная locomotion state machine
- локальный `idle/walk/strafe/backpedal/turn`

## Что не входит

- удалённые аватары
- lipsync
- seating
- authoritative sync

## Изменяемые модули

- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/xr.ts`
- `apps/runtime-web/src/avatar/avatar-controller.ts`
- `apps/runtime-web/src/avatar/avatar-ik.ts`
- `apps/runtime-web/src/avatar/avatar-locomotion.ts`

## Definition of Done

Фаза завершена, если:

1. Локальный пользователь в VR видит корректные self hands и body behavior.
2. Локальный пользователь на desktop/mobile получает целостный fallback avatar behavior.
3. При перемещении root legs визуально переходят в walk/strafe/backpedal/turn.
4. Head и arms не “ломают” скелет и не дают экстремальных поз.
5. При выключении feature flag система возвращается к текущему room flow без регрессии.

## Тесты

### Unit

- locomotion state transitions
- hand gesture mapping from controller buttons
- self visibility rules

### Manual

- Quest / WebXR: поднять руки, вращать контроллеры, ходить, делать snap turn
- Desktop: двигаться мышью/клавиатурой и проверять idle/walk transitions
- Mobile: убедиться в безопасном fallback behavior

### Артефакты выхода из фазы

- self-avatar работает локально
- есть управляемый локальный animation graph

---

# Phase 2 — Remote avatars и pose sync `v1`

Статус: DONE (2026-04-04)

## Цель

Сделать remote avatars с плавной синхронизацией head/hands/root поверх текущего realtime layer.

## Что входит

- reliable avatar state exchange
- binary pose frame codec
- room-state relay для transient pose
- pose ring buffers per remote avatar
- interpolation / short extrapolation
- avatar selection sync
- reconnect / late join support

## Что не входит

- lipsync
- seating
- full leg polish
- hand tracking over network beyond gesture presets

## Изменяемые модули

- `apps/room-state/src/index.ts`
- `apps/room-state/src/state.ts`
- `apps/runtime-web/src/room-state-client.ts`
- `apps/runtime-web/src/avatar/avatar-pose-codec.ts`
- `apps/runtime-web/src/avatar/avatar-pose-buffer.ts`
- `apps/runtime-web/src/avatar/avatar-transport.ts`
- `apps/runtime-web/src/avatar/avatar-instance.ts`

## Definition of Done

Фаза завершена, если:

1. Два и более клиента видят друг у друга head/hands/root в режиме реального времени.
2. Remote avatars двигаются плавно, без stop-motion на стабильной сети.
3. `avatarId` корректно синхронизируется и восстанавливается при late join.
4. Устаревшие pose frames корректно дропаются.
5. При reconnect не появляется duplicate remote avatar для одного participantId.
6. При отключении realtime avatar pose runtime откатывается в coarse capsule/fallback mode.

## Тесты

### Unit

- binary codec encode/decode
- seq ordering
- jitter buffer math
- interpolation / clamping tests

### Integration

- 2-4 клиента в локальной среде
- искусственный jitter / packet delay / packet reordering
- reconnect test

### Manual

- два Quest/desktop клиента
- быстрые движения руками
- проверка плавности на `room-state` transport

### Артефакты выхода из фазы

- remote avatar sync `v1`
- measured packet size / send rate / jitter stats
- staging smoke и public staging gate покрывают `demo-room`, `Hall`, scene switching, two-client avatar sync, reconnect и same-browser tab identity
- avatars включены по умолчанию для комнат staging/runtime, secure space links исправлены
- закрыты финальные регрессии Phase 2: same-browser identity collision, тяжёлый scene boot vs avatar boot, XR entry pitch carry-over, movement direction drift, VR remote hand visibility на web, scene-room avatar visibility

---

# Phase 3 — Ноги, gait solver и body naturalness

Статус на 2026-04-04: `core delivered on staging`, follow-up хвост остаётся по `avatarLegIkEnabled` runtime gate, `record/replay` trace harness и обзорному manual acceptance.

## Цель

Сделать походку и корпус естественными, чтобы аватары были похожи на social VR avatars, а не на “руки и голова на палке”.

## Что входит

- pelvis/spine refinement
- gait blending
- walk/strafe/backpedal clips
- turn-in-place
- near-avatar foot planting
- smoothing на transitions
- anti-foot-skating logic

## Что не входит

- seating
- lipsync
- rich hand tracking transport

## Изменяемые модули

- `apps/runtime-web/src/avatar/avatar-ik.ts`
- `apps/runtime-web/src/avatar/avatar-locomotion.ts`
- `apps/runtime-web/src/avatar/avatar-controller.ts`
- `apps/runtime-web/src/avatar/remote-avatar-runtime.ts`
- `apps/runtime-web/src/avatar/avatar-debug.ts`
- `apps/runtime-web/src/main.ts`
- `tests/e2e/runtime.spec.ts`
- `tests/e2e/runtime-staging.spec.ts`
- avatar animation assets

## Definition of Done

Фаза завершена, если:

1. При движении аватар не “скользит” телом без шагов.
2. При strafe/backpedal используется правильный набор анимаций.
3. При повороте на месте есть turn-in-place, а не “телепорт ног”.
4. Near avatars визуально правдоподобны в обычных social interactions.
5. Far avatars корректно деградируют в упрощённый locomotion mode без резких артефактов.

## Тесты

### Unit

- locomotion state machine thresholds
- clip blend weights
- anti-foot-skating correction

### Integration

- record/replay path traces
- deterministic bot paths

### Manual

- использовать существующий `bot` режим для прогонки предсказуемых траекторий
- проверить straight walk / circle / strafe / stop / turn

### Артефакты выхода из фазы

- natural locomotion `v1`
- gait regression scenes / traces

## Что уже реализовано

- shared locomotion classifier/hysteresis для `self` и `remote`
- общий `state <-> mode` contract для transport/runtime
- `pelvis/spine refinement`, `body lean`, `turn bias`
- `anti-foot-skating metric/correction`
- `near/far` quality mode
- `near-avatar foot planting v1`
- локальные и staging e2e проверки для legacy sync и нового locomotion diagnostics path
- staging verification пройдена для commit `571fd2b` и deploy run `23986540547`

## Что осталось до полного закрытия Phase 3

- повязать natural locomotion path на жёсткий runtime gate через `avatarLegIkEnabled`
- добавить обещанный `record/replay` / deterministic trace harness
- завершить расширенный staging suite для старого и нового avatar flow как постоянный regression gate
- в конце провести обзорный manual acceptance: desktop/desktop, desktop + Quest/WebXR, near/far social interactions, turn-in-place / strafe / backpedal / sharp stop

---

# Phase 4 — Lipsync, speaking feedback и expressive polish

## Цель

Добавить живость лицу и связать рот с реальным звуком.

## Что входит

- `AnalyserNode` для local mic path
- `AnalyserNode` для remote audio path
- morph driver
- smoothing envelope
- silence gate
- speaking indicator
- blink / subtle idle facial motion

## Что не входит

- speech-to-phoneme
- cloud viseme service
- complex face tracking

## Изменяемые модули

- `apps/runtime-web/src/voice.ts`
- `apps/runtime-web/src/spatial-audio.ts`
- `apps/runtime-web/src/avatar/avatar-lipsync.ts`
- `apps/runtime-web/src/avatar/avatar-instance.ts`

## Definition of Done

Фаза завершена, если:

1. Self-avatar реагирует ртом на локальный голос.
2. Remote avatar двигает ртом синхронно с тем аудио, которое реально слышно на клиенте.
3. Нет дополнительного сетевого payload для visemes.
4. При mute / отсутствии track рот возвращается в neutral.
5. Lipsync CPU cost контролируемый и ограничен caps/LOD.

## Тесты

### Unit

- envelope smoothing
- silence threshold
- amplitude -> morph mapping

### Integration

- synthetic audio source
- multiple speakers
- mute/unmute

### Manual

- два клиента говорят одновременно
- проверить рот на near/far LOD
- убедиться, что удалённый рот коррелирует со слышимым audio output

### Артефакты выхода из фазы

- lipsync `v1`
- audio-to-mouth profiling numbers

---

# Phase 5 — Seating и scene integration

## Цель

Добавить сидение как authoritative multiplayer interaction.

## Что входит

- seat anchors contract
- seat claim/release messages
- authoritative occupancy
- sit enter / sit idle / sit exit
- UI prompts
- hidden sit feature when seats absent

## Что не входит

- сложные interaction systems beyond seating
- generic object manipulation

## Изменяемые модули

- `apps/room-state/src/state.ts`
- `apps/runtime-web/src/avatar/avatar-seating.ts`
- `apps/runtime-web/src/scene-bundle.ts` / `scene-loader.ts`
- scene manifest schema

## Definition of Done

Фаза завершена, если:

1. Пользователь может сесть только на свободный seat.
2. Все участники видят seated state одинаково.
3. Конфликт seat claim корректно разрешается сервером.
4. При disconnect сидение освобождается.
5. В сценах без seat anchors UI не предлагает sit.

## Тесты

### Unit

- seat occupancy reducer
- claim/release conflict logic

### Integration

- two users race for same seat
- reconnect while seated
- disconnect cleanup

### Manual

- sit/stand в fallback room
- sit/stand в одной scene bundle c anchors
- проверка правильной ориентации на стуле

### Артефакты выхода из фазы

- seated mode `v1`
- scene schema extension for seats

---

# Phase 6 — Hardening, LOD, quality profiles, staging rollout

## Цель

Довести систему до production-grade поведения в вебе, с чётко измеряемыми лимитами и мягкой деградацией.

## Что входит

- full LOD policy
- hysteresis on quality switches
- caps on expensive avatars
- adaptive send rate
- runtime diagnostics
- fallback triggers
- staging rollout behind flags
- content budget verification in CI
- regression/perf runbook

## Что не входит

- persisted customization UI
- advanced face tracking
- lossy RTC transport (если не понадобился по результатам метрик)

## Изменяемые модули

- `apps/runtime-web/src/avatar/avatar-lod.ts`
- `apps/runtime-web/src/avatar/avatar-debug.ts`
- `apps/api/src/index.ts`
- `apps/room-state/src/index.ts`
- CI / docs / runbooks

## Definition of Done

Фаза завершена, если:

1. На target devices система держится в рамках согласованных quality profiles.
2. При перегрузе runtime мягко понижает LOD вместо лагов.
3. Все fallback reasons логируются.
4. Есть staging checklist и perf baseline.
5. Отключение аватаров feature flag’ом полностью возвращает room к стабильному capsule mode.

## Тесты

### Automated

- unit/integration regression
- asset budget CI
- transport regression tests

### Manual / staging

- Quest XR smoke
- desktop smoke
- mobile-lite smoke
- 2-4 participant session
- worst-case avatar catalog scene

### Артефакты выхода из фазы

- production-ready avatar subsystem `v1`
- staging rollout plan
- perf baseline report

---

# Phase 7 — Customization `v2` (после запуска `v1`)

## Цель

Добавить кастомизацию без смены рига, анимационного графа и сетевого протокола.

## Что входит

- UI выбора hair/outfit/palette/accessories
- persisted `AvatarRecipe`
- manifest/profile integration
- server-side validation of recipe
- preview in control-plane / profile

## Definition of Done

Фаза завершена, если:

1. Пользователь меняет элементы внешности без смены базового рига.
2. Recipe синхронизируется между участниками.
3. Runtime не делает лишних network fetches per participant.
4. Performance budgets не ломаются из-за кастомизации.

---

## 19. Приёмка по фазам: сводный чек-лист

| Phase | Что должно быть на выходе | Как понять, что фаза реально закончена |
|---|---|---|
| 0 | Contracts + avatar pack + loaders | 10 пресетов грузятся локально и проходят budget CI |
| 1 | Self-avatar | локальный аватар естественно движется в runtime |
| 2 | Remote sync | 2+ клиента видят плавные head/hands/root |
| 3 | Legs/naturalness | походка не выглядит как gliding proxy |
| 4 | Lipsync | рот двигается от реального аудио без extra network payload |
| 5 | Seating | seat occupancy authoritative и воспроизводима |
| 6 | Hardening | staging подтверждает стабильную деградацию и perf behavior |
| 7 | Customization | recipe-based кастомизация без архитектурных переделок |

---

## 20. Риски и как их гасить

### Риск 1. Слишком тяжёлые аватары убьют XR frame budget

**Ответ:**
- жёсткие budgets,
- KTX2 + meshopt,
- caps на expensive avatars,
- fallback до capsules.

### Риск 2. TCP/WebSocket будет рвать smoothness рук на плохой сети

**Ответ:**
- compact binary pose,
- latest-wins relay,
- adaptive jitter buffer,
- optional future migration transient pose в lossy RTC path.

### Риск 3. Hand tracking будет нестабилен или не везде доступен

**Ответ:**
- hand-tracking only as enhancement,
- base path = controller-driven hands,
- remote transport не зависит от полного hand skeleton.

### Риск 4. Сцены не готовы для sit / foot placement

**Ответ:**
- seating только через explicit anchors,
- flat-ground fallback для ног,
- sit UI скрывать, если anchors отсутствуют.

### Риск 5. Разработка снова разрастётся в один `main.ts`

**Ответ:**
- Phase 0 фиксирует модульную структуру,
- новые avatar features только в `src/avatar/*`.

---

## 21. Что я бы считал “правильным финалом `v1`”

`v1` считается завершённым только если одновременно соблюдены все условия:

1. Есть 10 пресетов на общем rig.
2. Local и remote avatars работают в одном room flow.
3. В VR руки следуют контроллерам, а тело выглядит правдоподобно.
4. Ноги ходят от locomotion state, а не висят мёртво.
5. Рот двигается от звука без дополнительного viseme networking.
6. При наличии seat anchors пользователь может сесть.
7. Система не ломает web/XR smoothness и имеет LOD/fallback.
8. Всё это отключается feature flag’ом без повреждения текущего продукта.

---

## 22. Конкретные рекомендации по внедрению именно в этот репозиторий

### Делать обязательно

- начать с выноса avatar logic из `apps/runtime-web/src/main.ts`
- не трогать слой разделения runtime / media / state plane
- строить avatar state как отдельный контракт, а не расширять coarse presence без границ
- использовать текущие `motion-state` идеи как основу buffer/interpolation layer
- использовать существующий diagnostics path для метрик avatar subsystem
- использовать существующий `bot` режим как вспомогательный инструмент для deterministic locomotion tests

### Не делать

- не тянуть Meta SDK в `Three.js` runtime как core dependency
- не делать `room-state` просто “чатом JSON сообщений” для всего high-frequency pose path
- не пытаться стартовать с глубокой кастомизации до появления стабильного `v1`
- не тащить в runtime поддержку “какого угодно формата аватаров”

---

## 23. Внешние опорные источники, на которые можно ориентироваться при реализации

Ниже — не “источник истины для продукта”, а набор внешних технических ориентиров для инженерной команды.

- Meta Avatars SDK Overview  
  https://developers.meta.com/horizon/documentation/unity/meta-avatars-overview/

- Meta Avatars SDK Networking  
  https://developers.meta.com/horizon/documentation/unity/meta-avatars-networking/

- Meta Avatars SDK announcement / supported platforms context  
  https://developers.meta.com/horizon/blog/meta-avatars-sdk-now-available/

- LiveKit data packets (reliable vs lossy)  
  https://docs.livekit.io/transport/data/packets/

- MDN `AnalyserNode`  
  https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode

- MDN `XRInputSource.hand`  
  https://developer.mozilla.org/en-US/docs/Web/API/XRInputSource/hand

- MDN `XRInputSource.gamepad`  
  https://developer.mozilla.org/en-US/docs/Web/API/XRInputSource/gamepad

- MDN `XRFrame.getJointPose()`  
  https://developer.mozilla.org/en-US/docs/Web/API/XRFrame/getJointPose

- three.js `WebXRManager`  
  https://threejs.org/docs/pages/WebXRManager.html

- three.js `GLTFLoader`  
  https://threejs.org/docs/pages/GLTFLoader.html

- three.js `KTX2Loader`  
  https://threejs.org/docs/pages/KTX2Loader.html

- Khronos `KHR_texture_basisu`  
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md

- Khronos `EXT_meshopt_compression`  
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md

- Khronos `KHR_draco_mesh_compression`  
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md
