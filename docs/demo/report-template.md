# Public demo: redacted acceptance report

Дата и ответственный: __________

Платформа SHA / staging deploy run / Docker image SHA: __________

Demo runId / tenantId / roomId (без invite links): __________

Шаблон: meeting-room-basic@2.0.0; сцена: warm-modern-meeting-room-candidate-01@0.3.4, pinned commit a237ab799acbee3932846147c9f48bf1d1b4aaa8.

Окружение и origin **без query-параметров**: __________

Проверявшие (четыре человека), browser/OS и сеть: __________

Независимый clean-clone автор, exact SHA, project и доказательство: __________

| Шаг | pass / fail / not-run | Доказательство, диагностика (без секретов) |
|---|---|---|
| D01 private join и четыре remote | | |
| D02 двусторонняя слышимость двух реальных микрофонов, mute/unmute | | |
| D03 notes saved/reload, guest read-only | | |
| D04 PDF 1→2 у всех, видимая поверхность | | |
| D05 reload/late join/page 2→3, отсутствие ghost | | |
| D06 host lock/unlock и server-side guest отказ | | |
| D07 host remove и присутствие оставшихся | | |
| D08 решение записано, показ завершён, cleanup | | |

Автоматический local CLI integration (Postgres/restart/blob): __________

Автоматический local browser scenario (без voice acceptance): __________

Автоматический staging WebRTC transport (отдельно от ручной слышимости): __________

Full local suite / CI / Docker Publish / Staging Deploy / full staging suite (run URLs и результат): __________

Cleanup: private state удалён / redacted record / документы, blob, room и tenant удалены / retry или rollback: __________

Реальный обзор PDF на обычной поверхности, сцены и четырёх клиентов: __________

Итог AC-033-01…10: __________

Не вкладывать private state, приглашения, токены, URL с `invite`, raw traces или video с персональными ссылками. Synthetic audio не подменяет ручную проверку речи.
