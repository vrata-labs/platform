# M1.2 — протокол ввода на медийную поверхность

## Статус

Статус: `done`.

Закрыта: 2026-05-12.

Принятая версия: `c0bda45f541fcba8a89d7830ffef4c38bc3e4605`.

Подтверждение:

- локально прошли `git diff --check`, `pnpm --filter @noah/shared-types test`, `pnpm --filter @noah/runtime-web build`, `pnpm --filter @noah/runtime-web test`, `pnpm exec playwright test tests/e2e/m1-media --workers=1` и `pnpm test:e2e`;
- CI run `25736402601` прошел;
- Docker Publish run `25736402599` прошел;
- Staging Deploy run `25736527346` прошел;
- `pnpm test:e2e:staging` прошел: 33 теста;
- staging-запуск `tests/e2e/m1-media/surface-input-protocol.spec.ts` прошел: 4 теста.

Стартовый контекст: M1.1 закрыта и дает роли, permissions, access debug contract и server-side проверку privileged actions. M1.2 должна использовать этот access foundation и не обходить его клиентским состоянием.

## Цель

Сделать единый протокол ввода для всех медийных поверхностей.

Один и тот же объект должен получать события независимо от того, чем пользователь управляет:

- мышью;
- касанием на телефоне;
- клавиатурой;
- лучом контроллера в виртуальной реальности;
- будущим вводом рукой.

## Не входит

- полноценный реестр медийных объектов;
- persistent список медийных поверхностей в состоянии комнаты;
- запуск `screen-share`, `whiteboard` или `remote-browser`;
- shared lifecycle блокировок поверхностей, кроме минимального debug/test состояния;
- production UI меню поверхности.

## Граница M1.2

M1.2 реализует общий протокол ввода и временный debug/test sink. Если настоящих media surfaces из M1.3 еще нет, используется debug surface с фиксированным `surfaceId`. Доставка события настоящему медийному объекту начинается в M1.3.

M1.2 не должна превращаться в M1.3. Любое состояние поверхности, фокус или блокировка в этой подфазе нужны только для проверки input protocol и debug contract.

## Почему это отдельная подфаза

Без общего протокола каждый объект начнет реализовывать собственный способ работы с вводом. В итоге доска, трансляция, удаленный браузер и будущие объекты будут несовместимы.

Эта подфаза создает основу расширяемости.

## Основной принцип

Любой ввод сначала превращается в координаты поверхности.

```text
источник ввода
        ↓
попадание в трехмерную поверхность
        ↓
координаты u/v от 0 до 1
        ↓
координаты объекта в пикселях
        ↓
SurfaceInputEvent
        ↓
медийный объект
```

## Протокол события

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

## Координаты `uv`

`uv.u = 0` означает левую границу поверхности.

`uv.u = 1` означает правую границу поверхности.

`uv.v = 0` означает верхнюю границу поверхности.

`uv.v = 1` означает нижнюю границу поверхности.

Это правило нужно зафиксировать и проверить тестами. Нельзя допускать, чтобы один объект считал `v = 0` верхом, а другой — низом.

## Источники ввода

### Мышь

Используется в обычном браузере. Луч строится из камеры через положение курсора.

### Касание

Используется на телефоне и планшете. Касание экрана преобразуется в луч из камеры или в действие поверх выбранной поверхности, если включен специальный режим взаимодействия.

### Луч виртуальной реальности

Используется в WebXR. Луч строится из контроллера или руки. Попадание в поверхность дает координаты `uv`.

### Клавиатура

Клавиатура отправляется только активному объекту, который находится в фокусе. Например, удаленный браузерный объект или доска с текстовым инструментом.

## Фокус и блокировка

Поверхность может быть выбрана участником.

```ts
type SurfaceFocusState = {
  focusedSurfaceId?: string;
  focusedObjectId?: string;
  focusedByParticipantId?: string;
  focusKind: 'local' | 'shared' | 'locked';
};
```

Правила:

1. Локальный фокус нужен для меню и подсветки.
2. Общий фокус нужен, когда ведущий показывает участникам, с какой поверхностью работает.
3. Блокировка нужна, когда объект не должен принимать одновременный ввод от нескольких участников.

Для доски одновременный ввод можно разрешить.

Для удаленного браузера в первой версии рекомендуется один управляющий участник за раз.

В M1.2 `SurfaceFocusState` допускается только как локальное debug/test состояние. Shared/server-side focus, lock ownership и object lifecycle относятся к M1.3.

## Модель прав

- `guest`: может видеть debug hit state, но не отправляет `SurfaceInputEvent` в sink;
- `member`: может отправлять pointer input при наличии `surface.input`;
- `host` / `admin`: могут select/focus surface при наличии `surface.select`;
- клавиатурный ввод отправляется только активному debug focus и только при наличии `surface.input`;
- любая заблокированная команда должна обновлять debug state с `blockedReason`.

## Затронутые точки

- `packages/shared-types/src/*` — типы `SurfaceInputEvent`, source/kind, debug contract;
- `apps/runtime-web/src/input/*` — преобразование raw input в surface input intent;
- `apps/runtime-web/src/interaction/*` — pure hit resolution без изменения pose/seating/room state;
- `apps/runtime-web/src/locomotion/*` — сохранить XR frame sampling, snap-turn suppression, teleport/seating behavior;
- `apps/runtime-web/src/main.ts` — только orchestration/debug hook, без новой domain логики;
- `tests/e2e/m1-media/surface-input-protocol.spec.ts` — приемка M1.2.

## Инварианты регрессии

- XR input сэмплируется один раз за кадр и не дублируется для surface input;
- ray intent не ломает snap-turn suppression;
- teleport/seating confirm path не перехватывается surface input;
- target resolution не мутирует pose, seating state, room state или visuals;
- guest/member/host permissions берутся из M1.1 access foundation, а не из client-side role mutation.

## Визуальная обратная связь

Для каждой поверхности нужно показывать:

- наведение луча или курсора;
- выбранную поверхность;
- блокировку ведущим;
- недоступность действия из-за роли;
- активный объект на поверхности.

## Задачи агента

1. Найти текущую систему ввода.
2. Добавить вычисление попадания в медийную поверхность.
3. Добавить преобразование попадания в `uv`.
4. Добавить единый тип `SurfaceInputEvent`.
5. Добавить отправку событий объекту, прикрепленному к поверхности.
6. Добавить отладочные данные последнего попадания.
7. Добавить режим робота для проверки ввода:

```text
?surfaceBot=click&surfaceId=main
?surfaceBot=draw&surfaceId=board
```

## Автоматические проверки

Создать:

```text
tests/e2e/m1-media/surface-input-protocol.spec.ts
```

Проверки:

1. Мышь попадает в поверхность и дает `uv` в диапазоне от `0` до `1`.
2. Клик по центру поверхности дает примерно `u = 0.5`, `v = 0.5`.
3. Клик за пределами поверхности не создает событие объекта.
4. Робот ввода создает событие `pointer-down`, затем `pointer-up`.
5. Событие содержит `participantId`, `surfaceId`, `seq` и `clientTimeMs`.
6. Имитация ввода виртуальной реальности создает событие с `source = 'xr-controller'`.
7. Гость получает `blockedReason = 'missing-permission:surface.input'` и не создает accepted event.
8. Заблокированная, disabled или missing debug surface не принимает input event.
9. XR ray intent продолжает подавлять diagonal snap-turn, а teleport/seating confirm path остается рабочим.
10. Debug state содержит `lastHit`, `lastEvent` и `blockedReason`.

Unit-тесты должны покрывать:

- mouse/touch/XR hit -> стабильные `uv`;
- `uv` outside range rejection;
- monotonic `seq` или documented local seq behavior;
- permission gating для `surface.input` и `surface.select`;
- отсутствие побочных эффектов в target resolution.

## Критерии готовности

Подфаза закрыта, если:

- ввод мышью, касанием и имитацией виртуальной реальности сводится к одному протоколу;
- координаты поверхности стабильны и проверены;
- объекту не нужно знать, каким устройством пользователь управлял;
- в отладочных данных виден последний ввод на поверхность;
- permission gating использует access foundation из M1.1;
- текущие XR ray, snap-turn, teleport и seating сценарии не сломаны;
- автоматические проверки проходят.

Фактический результат M1.2: критерии закрыты через общий shared-types contract, pure runtime input resolver, debug/test sink на `debug-main`, permission gating и локальные/staging e2e проверки. Persistent media surface registry, shared object lifecycle и доставка события настоящим объектам остаются за M1.3.

## Что не считать готовностью

- Доска получает координаты мыши напрямую, минуя общий протокол.
- Луч виртуальной реальности реализован отдельно и несовместим с мышью.
- Координаты `uv` не проверены тестами.
- Поверхность может принимать ввод без проверки роли участника.
