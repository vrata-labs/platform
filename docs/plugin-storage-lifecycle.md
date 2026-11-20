# Self-host: sandbox assets и жизненный цикл комнаты

## Поставка без CDN

Sandbox использует только assets собственного API origin. QuickJS 0.32.0 и зависимости закреплены в pnpm-lock.yaml; SHA-256 исходных WASM, browser glue и FFI — в infra/docker/plugin-runtime.lock.json. Vite встраивает glue/FFI в guest worker. WASM загружает основной поток и передаёт compiled module в worker; guest не получает сеть. Обычные сцены и медиа могут использовать другие origin — это не зависимость sandbox.

```bash
pnpm install --frozen-lockfile
pnpm build
node tools/plugin-runtime-assets.mjs --verify
docker build -f apps/api/Dockerfile -t vrata-api:local .
```

Сборка создаёт assets/plugin-runtime/releases.json: URL, SHA-256 и размер каждого worker, WASM и опубликованного SDK archive. Docker повторно проверяет его до prune и копирует runtime dist/public целиком. Не копируйте только index.html или один JavaScript bundle. Не запускайте --write-lock ради обхода ошибки: изменение lock требует проверки обновлённой зависимости и повтора sandbox tests.

На собственном HTTPS origin проверьте manifest и все его assets: точные SHA/размеры, application/wasm для WASM, application/javascript для worker, nosniff. Guest worker: default-src 'none', connect-src 'none', worker-src 'none', script-src 'wasm-unsafe-eval'. Kernel: connect-src 'none', script-src 'none', worker-src 'self'. Прокси не должен ослаблять эти заголовки или возвращать HTML вместо отсутствующего asset.

Hash URLs имеют Cache-Control: public, max-age=31536000, immutable; HTML и releases.json — no-cache. При обновлении сохраняйте согласованную пару HTML/assets. Уже открытой вкладке со старым кодом после замены образа может понадобиться reload: browser cache не гарантирует наличие старых bytes на сервере. Room-scoped package/config/content API остаются no-store с проверкой сессии.

## Restart и restore

1. Активируйте reference catalog и identity v2 по инструкции self-hosting. Подготовьте отдельный demo run через demo:public seed; Host загружает две версии внешнего пакета из SDK и включает точную версию с разрешёнными capabilities. Сохраните PDF, Notes и привязку поверхности. В соседней комнате оставьте свой пакет.
2. Запишите version/hash, revision/config bindings и checksums без credentials, приглашений и plugin source. Перезапустите API, выполните demo:public check, обновите вкладку. Host сохраняет авторские права, Guest их не получает; включённый пакет запускается, прежняя версия остаётся в библиотеке.
3. Выполните штатный backup:compose с теми же env/compose files. Manifest v2 должен включать private objects и checksums. Восстанавливайте через restore:compose только на выделенной копии, с теми же storage coordinates/секретами и без конкурирующих писателей. Не подменяйте backend fingerprint при смене endpoint.
4. После restore повторите шаг 2; скачайте документ и bound artifact побайтно, проверьте Notes/версии, room settings, bindings и доступ согласно выбранной процедуре восстановления. Правила ротации credentials/media namespace из self-hosting сохраняются для восстановления реальной установки.

Room state здесь — долговечные настройки комнаты, доступ, Notes/версии и document metadata/bindings. Whiteboard и текущие media objects живут в работающем room-state; сохранение доски после его рестарта не обещается. Итоги встречи сохраняйте в Notes.

## Повторяемая очистка

demo:public cleanup проверяет origin, tenant/room ownership и удаляет только ресурсы собственного run. Порядок для плагинов: disable → unbind → plugin blobs → document blobs → room → tenant. Между CAS-операциями библиотека перечитывается. Общий SDK и данные соседней комнаты остаются.

После End CLI всегда вызывает штатный DELETE комнаты до удаления документов. Сохранённый pluginsCleaned — только checkpoint, не доказательство отсутствия новых пакетов: durable intent закрывает новые публикации, повторно очищает plugin blobs и только затем документы. Отдельные HTTP DELETE документов в CLI не используются.

Partial failure возвращает ошибку и сохраняет private state и redacted cleanup record. Устраните причину и повторите команду; не удаляйте строки вручную. После успеха остаётся только redacted record. Повтор по .cleanup.json также удаляет исходный private state, только если его run/origin/room/tenant совпадают.

Прямой DELETE /api/rooms/:roomId использует durable cleanup intent и удаляет байты до parent row. Отказ storage сохраняет комнату и ключи для повторного DELETE после рестарта API. Неизвестный исход загрузки не признаётся завершённым по таймауту или доступному GET. Конкурентно появившийся документ оставляет комнату для повтора после финальной parent-проверки.

Проверки: storage-lifecycle.spec.ts, public-demo-cli.integration.spec.ts, plugin-sdk-distribution.spec.ts, plugins/storage-contract.test.ts, public-demo.test.mjs и существующая backup-restore матрица. Fresh-clone self-host, физические устройства и встреча четырёх людей остаются отдельной продуктовой приёмкой.
