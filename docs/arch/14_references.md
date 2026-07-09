# Справочные источники

Эти ссылки нужны агенту как технические ориентиры. При реализации следует сверяться с официальной документацией, а не с пересказами.

## Захват экрана и потоковое видео

- MDN: `MediaDevices.getDisplayMedia()` — https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- MDN: Screen Capture API — https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API
- MDN: Permissions-Policy `display-capture` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/display-capture
- LiveKit: Screen sharing — https://docs.livekit.io/transport/media/screenshare/
- LiveKit: tracks — https://docs.livekit.io/intro/basics/rooms-participants-tracks/tracks/

## Ввод в виртуальной реальности

- MDN: WebXR Device API — https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API
- MDN: WebXR inputs and input sources — https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Inputs
- MDN: XRInputSource — https://developer.mozilla.org/en-US/docs/Web/API/XRInputSource

## Базовые архитектурные источники проекта

- `docs/product-scope.md`
- `docs/architecture.md`
- `docs/status.md`
- handoff M0.5 / mobile media

## Важная практическая заметка

Захват экрана ведущего и управление произвольной веб-страницей — разные сценарии.

Захват экрана дает видеопоток.

Управление страницей требует исполнителя команд: удаленного браузера или специальной интеграции.
