# Backlog

- [Remote-browser callbacks не работают на поверхности, отличной от debug-main](2026-10-11-remote-browser-callback-surface.md) — parked — объект на другой поверхности остаётся loading из-за callback surface mismatch.
- [Пример auto-seat показывает «не разрешена» после перезапуска экземпляра](2026-10-23-auto-seat-status-after-lease-restart.md) — parked — новый экземпляр получает room.ready после использованного права прибытия и заменяет «Заявка принята».
- [Auto-deploy main не дожидается полного CI](2026-10-23-main-auto-deploy-ci-wait.md) — promoted — решено шардированием CI (#135, #136): CI около 16 минут укладывается в 30-минутное ожидание.
- [Ревизия e2e-набора: проверки идут слишком долго](2026-10-23-e2e-suite-revision.md) — promoted — сделано в #135 и #136: CI 62 → ~16 минут, staging gate 46 → 14 минут; хвосты описаны в пункте.
- [До входа на floor 2 не видны настройки шаблона комнаты](2026-10-24-prejoin-template-defaults-floor-two.md) — parked — анонимное чтение манифеста перед экраном входа отклоняется; гость по умолчанию входит с выключенным микрофоном.
- [Создание стенда падает на временных сбоях Selectel без повтора](2026-10-25-vrata-stage-transient-provider-retry.md) — new — «Failed to allocate the network(s)» переводит стенд в failed, повтор только вручную.
- [Забытый стенд удаляется, только пока работает машина разработки](2026-10-25-stage-watcher-needs-operator-machine.md) — new — уборщик живёт на машине разработки; при выключенной машине стенд оплачивается дальше.
- [Продукт стартует с identity floor 1, хотя его поддержка больше не нужна](2026-10-26-floor-one-product-default.md) — new — путь floor 1, его тесты и пять rollback-баз CI убирать вместе; откат гарантируется только к предыдущему релизу.
- [Вход в голос сдаётся после неудачного ICE и не пробует другой путь](2026-10-26-voice-join-gives-up-after-ice-failure.md) — new — через ~17 с клиент возвращает «Join Audio» без повтора через TCP или relay; из-за этого тест двухстороннего звука ушёл из gate.
- [Room-state хранит состояние удалённой комнаты под тем же roomId](2026-10-26-room-state-recreated-room-isolation.md) — parked — состояние room-state не сбрасывается при удалении комнаты, пересозданная встреча видит прежние объекты и привязки исполнителя.
- [identity-boundary: первая загрузка комнаты иногда ждёт 90 секунд](2026-10-26-identity-boundary-personal-owner-cold-start.md) — parked — редкий таймаут page.goto сразу после raise(2), чаще при высокой нагрузке.
