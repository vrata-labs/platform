# Backlog

- [Remote-browser callbacks не работают на поверхности, отличной от debug-main](2026-10-11-remote-browser-callback-surface.md) — parked — объект на другой поверхности остаётся loading из-за callback surface mismatch.
- [Пример auto-seat показывает «не разрешена» после перезапуска экземпляра](2026-10-23-auto-seat-status-after-lease-restart.md) — parked — новый экземпляр получает room.ready после использованного права прибытия и заменяет «Заявка принята».
- [Auto-deploy main не дожидается полного CI](2026-10-23-main-auto-deploy-ci-wait.md) — parked — ожидание CI 30 минут, а полный CI около 1,5 часа; слияния в main не выкатываются сами.
- [Ревизия e2e-набора: проверки идут слишком долго](2026-10-23-e2e-suite-revision.md) — parked — CI около 1,5 часа без шардирования, полный local около часа, дублирующие и нестабильные сценарии.
- [До входа на floor 2 не видны настройки шаблона комнаты](2026-10-24-prejoin-template-defaults-floor-two.md) — parked — анонимное чтение манифеста перед экраном входа отклоняется; гость по умолчанию входит с выключенным микрофоном.
