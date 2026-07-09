# M1.5 — интерактивная доска

## Итог реализации

Статус: `done` по состоянию на 2026-05-14.

Закрытый объем:

- `whiteboard` работает как медийный объект поверх общего протокола поверхности.
- Состояние доски authoritative в room-state: штрихи, `revision`, защита от duplicate/stale patch, лимиты размера.
- `whiteboard.draw` и `whiteboard.clear` проверяются по ролям; `member` может рисовать, `host/admin` могут очищать.
- Web ввод, синтетический XR ввод и contact VR pencil проходят через surface input path.
- Local preview остается lightweight overlay geometry; canvas texture не обновляется per-frame, чтобы не возвращать VR flicker.
- VR pencil привязан к shared hand-pose source; `gripSpace`/resolved hand pose остается источником для avatar hands и pencil, `targetRaySpace` остается для ray/teleport.
- `Draw: Off` скрывает VR pencil и блокирует XR whiteboard drawing; `Draw: On` явно включает видимость pencil и drawing path.

Ключевые задеплоенные коммиты:

- Baseline M1.5 whiteboard: `b3f54520e27cfd15f7b8c504056bd2e7ebb6314f`.
- Web/VR draw handling: `a7e56889b96973636d06307a00be20be8c5c5e11`.
- Preview texture flicker fix: `f58062d0d15fc23f75d2547e10f52138700a0f10`.
- Contact pencil hit path: `70b5930b77194e658d500aee77df47bb7649192c`.
- Pencil hand anchoring: `c9470ae5bca6d265c671abe64c6f83b0b586937f`.
- Shared hand-pose source: `7f62ead5a08e899079176f0a3be3c7bdeaf7a8a6`.
- Pencil grip-angle tuning: `3fe7abbd83d50a09f36aba8f058c73544d6ececc`.
- Draw-toggle gating: `50d1bbc6885e14df61edd93d6ea14c98ddb2c500`.

Финальная проверка для `50d1bbc6885e14df61edd93d6ea14c98ddb2c500`:

- Local: runtime build/test, lint, typecheck, repo build/test, full local e2e.
- GitHub Actions: CI `25847859871`, Docker Publish `25847859884`, Staging Deploy `25847941037`.
- Staging: deploy gate `33 passed`, workspace `pnpm test:e2e:staging` `33 passed`, targeted `whiteboard-object` `6 passed`.

## Цель

Реализовать первый полностью собственный интерактивный медийный объект VRATA: доску.

Доска нужна по двум причинам:

1. Это полезный деловой объект для встреч.
2. Это безопасный способ проверить протокол ввода поверхностей без зависимости от сторонних веб-страниц.

## Пользовательский сценарий

1. Ведущий выбирает поверхность.
2. Ведущий включает объект «Доска».
3. Участники с правом рисования рисуют мышью, касанием или лучом из виртуальной реальности.
4. Все участники видят линии почти сразу.
5. Ведущий может очистить доску.
6. Доска сохраняет состояние при кратком повторном подключении участника.

## Состояние доски

Рекомендуемый первый формат — векторные штрихи.

```ts
type WhiteboardState = {
  status: 'active' | 'locked' | 'failed';
  strokes: WhiteboardStroke[];
  revision: number;
};

type WhiteboardStroke = {
  strokeId: string;
  participantId: string;
  tool: 'pen' | 'eraser';
  color: string;
  width: number;
  points: Array<{
    u: number;
    v: number;
    t: number;
    pressure?: number;
  }>;
};
```

Пояснение:

- `u/v` позволяют доске работать на поверхностях любого размера.
- `revision` нужен для порядка обновлений.
- В первой версии не нужно делать сложные фигуры, текст и экспорт.

## Инструменты первой версии

Минимально:

- перо;
- ластик или очистка всей доски;
- выбор толщины;
- выбор 2–3 цветов;
- очистка доски ведущим.

Не делать в первой версии:

- распознавание фигур;
- совместное редактирование текста;
- бесконечный холст;
- импорт изображений;
- экспорт PDF;
- сложную историю отмены.

## Правила доступа

- Гость может смотреть.
- Участник может рисовать, если есть `whiteboard.draw`.
- Ведущий может очищать доску, если есть `whiteboard.clear`.
- Администратор может остановить объект.

## Обработка ввода

Доска должна принимать только `SurfaceInputEvent`.

Правила:

- `pointer-down` начинает штрих;
- `pointer-move` добавляет точки;
- `pointer-up` завершает штрих;
- `click` без движения может создать короткую точку;
- события вне поверхности игнорируются;
- события без права `whiteboard.draw` игнорируются и фиксируются в диагностике.

## Синхронизация

Для первой версии используется простая authoritative-модель через состояние комнаты:

- автор рисует локальный preview сразу, без ожидания сети;
- при `pointer-up` или `click` runtime отправляет один завершенный штрих;
- служба состояния валидирует patch и append-only добавляет штрих в объект доски;
- `revision` увеличивается на каждый принятый штрих или очистку;
- при `revision-mismatch` клиент обновляется по следующему snapshot и может повторить действие только с новым `expectedRevision`;
- streaming точек во время движения, отдельный low-latency канал и merge незавершенных штрихов в M1.5 не входят.

Рекомендуемая схема:

```text
локальное рисование сразу отображается у автора
        ↓
точки отправляются с ограничением частоты
        ↓
служба состояния применяет обновление
        ↓
участники получают новый штрих или пачку точек
        ↓
доска перерисовывается
```

## Patch protocol v1

```ts
type WhiteboardPatch =
  | { type: 'append-stroke'; stroke: WhiteboardStroke; inputEventId: string }
  | { type: 'clear'; inputEventId: string };
```

Правила:

- `append-stroke` требует `whiteboard.draw`;
- `clear` требует `whiteboard.clear`;
- `inputEventId` защищает от повторного применения одного события;
- accepted colors и widths берутся из фиксированного allowlist;
- v1 ограничивает размер состояния: не больше 500 штрихов и 256 точек на штрих;
- `eraser` в M1.5 можно не реализовывать как hit-testing по штрихам; достаточно `clear`.

## Отладочные данные

```ts
whiteboard: {
  objectId: string;
  surfaceId: string;
  active: boolean;
  strokeCount: number;
  revision: number;
  localCanDraw: boolean;
  lastInputSource?: 'mouse' | 'touch' | 'xr-controller' | 'xr-hand' | 'keyboard';
  lastPoint?: { u: number; v: number };
}
```

## Задачи агента

1. Зарегистрировать тип объекта `whiteboard`.
2. Реализовать холст доски на поверхности.
3. Реализовать инструменты первой версии.
4. Подключить протокол ввода поверхности.
5. Реализовать синхронизацию штрихов.
6. Реализовать очистку доски ведущим.
7. Добавить диагностические данные.
8. Добавить робота для рисования:

```text
?surfaceBot=draw&object=whiteboard
```

Точки реализации:

- `packages/shared-types/src/media-objects.ts`: `WHITEBOARD_OBJECT_TYPE`, `WhiteboardState`, `WhiteboardStroke`, `WhiteboardPatch`;
- `apps/room-state/src/state.ts`: initial state, patch reducer, validation, permissions, duplicate/revision handling;
- `apps/room-state/src/index.ts`: существующий `surface_patch_object_state` остается command entry point;
- `apps/runtime-web/src/main.ts`: routing `SurfaceInputEvent` по активному объекту, локальный preview и surface texture redraw;
- `tests/e2e/m1-media/whiteboard-object.spec.ts`: product e2e acceptance.

## Автоматические проверки

Создать:

```text
tests/e2e/m1-media/whiteboard-object.spec.ts
```

Проверки:

1. Ведущий создает доску на поверхности.
2. Участник с правом рисования рисует штрих.
3. Другой участник видит увеличение `strokeCount`.
4. Координаты штриха находятся в диапазоне `0..1`.
5. Ввод виртуальной реальности через имитацию создает штрих.
6. Гость без права рисования не может изменить доску.
7. Ведущий очищает доску.
8. После очистки `strokeCount = 0` у всех участников.
9. Повторный вход участника восстанавливает текущее состояние доски.
10. Два участника рисуют по одному штриху без потери данных.
11. Повторный или stale patch отклоняется диагностируемо.
12. Участник без `whiteboard.clear` не может очистить доску.

## Критерии готовности

Подфаза закрыта, если:

- доска работает как медийный объект, а не как особый случай ядра;
- доска принимает ввод через протокол поверхности;
- мышь, касание и имитация луча работают одинаково;
- состояние доски синхронизируется между участниками;
- права рисования проверяются;
- автоматические проверки проходят.

## Что не считать готовностью

- Доска работает только локально.
- Доска принимает только мышь, но не общий протокол ввода.
- Очистка доски не синхронизируется.
- Любой гость может очистить доску.
- Доска реализована как жестко зашитый элемент сцены.
