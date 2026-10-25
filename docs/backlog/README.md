# Backlog

- [Remote-browser callbacks не работают на поверхности, отличной от debug-main](2026-10-11-remote-browser-callback-surface.md) — parked — объект на другой поверхности остаётся loading из-за callback surface mismatch.
- [Пример auto-seat показывает «не разрешена» после перезапуска экземпляра](2026-10-23-auto-seat-status-after-lease-restart.md) — parked — новый экземпляр получает room.ready после использованного права прибытия и заменяет «Заявка принята».
- [Auto-deploy main не дожидается полного CI](2026-10-23-main-auto-deploy-ci-wait.md) — parked — ожидание CI 30 минут, а полный CI около 1,5 часа; слияния в main не выкатываются сами.
- [Ревизия e2e-набора: проверки идут слишком долго](2026-10-23-e2e-suite-revision.md) — parked — CI e2e 54 минуты в один поток, staging gate 46 минут, дубли M0.5 и клиентских тестов на staging, нестабильные тесты в gate bootstrap.
- [До входа на floor 2 не видны настройки шаблона комнаты](2026-10-24-prejoin-template-defaults-floor-two.md) — parked — анонимное чтение манифеста перед экраном входа отклоняется; гость по умолчанию входит с выключенным микрофоном.
- [Создание стенда падает на временных сбоях Selectel без повтора](2026-10-25-vrata-stage-transient-provider-retry.md) — new — «Failed to allocate the network(s)» переводит стенд в failed, повтор только вручную.
- [Забытый стенд удаляется, только пока работает машина разработки](2026-10-25-stage-watcher-needs-operator-machine.md) — new — уборщик живёт на машине разработки; при выключенной машине стенд оплачивается дальше.
