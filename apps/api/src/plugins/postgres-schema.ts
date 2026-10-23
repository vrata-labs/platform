import type { PoolClient } from "pg";

export async function installRoomPluginSchema(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists room_plugin_state (
      tenant_id text not null, room_id text not null,
      revision bigint not null default 0 check (revision between 0 and 9007199254740991),
      deleting boolean not null default false,
      deletion_id text,
      cleanup_package_ids jsonb not null default '[]' check (jsonb_typeof(cleanup_package_ids)='array' and jsonb_array_length(cleanup_package_ids)<=10),
      check (deleting = (deletion_id is not null)),
      primary key (tenant_id, room_id),
      foreign key (tenant_id, room_id) references rooms(tenant_id, room_id) on delete cascade
    );
    create table if not exists room_plugin_packages (
      tenant_id text not null, room_id text not null, package_id text not null,
      plugin_id text not null, version text not null,
      artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
      byte_length integer not null check (byte_length between 1 and 1048576),
      manifest jsonb not null check (jsonb_typeof(manifest)='object'),
      storage_key text not null unique,
      backend_fingerprint text constraint room_plugin_backend_hash check (backend_fingerprint is null or backend_fingerprint ~ '^[a-f0-9]{64}$'),
      state text not null check (state in ('reserved','ready','cleanup-pending','deleted')),
      upload_settled boolean not null default false,
      check (state='reserved' or upload_settled),
      created_at timestamptz not null,
      primary key (tenant_id, room_id, package_id),
      unique (tenant_id, room_id, plugin_id, version),
      unique (tenant_id, room_id, package_id, plugin_id, version, artifact_sha256),
      foreign key (tenant_id, room_id) references rooms(tenant_id, room_id) on delete restrict
    );
    -- Older records retain NULL, which cannot authorize IO against today's possibly changed target.
    alter table room_plugin_packages add column if not exists backend_fingerprint text;
    do $backend$
    begin
      if not exists (select 1 from pg_constraint where conrelid='room_plugin_packages'::regclass and conname='room_plugin_backend_hash') then
        alter table room_plugin_packages add constraint room_plugin_backend_hash check (backend_fingerprint is null or backend_fingerprint ~ '^[a-f0-9]{64}$');
      end if;
    end; $backend$;
    create table if not exists room_plugin_bindings (
      tenant_id text not null, room_id text not null, plugin_id text not null,
      package_id text not null, version text not null, artifact_sha256 text not null,
      binding_id text not null, generation bigint not null check (generation between 0 and 9007199254740991),
      binding_revision bigint not null check (binding_revision between 0 and 9007199254740991),
      enabled boolean not null, approved_capabilities jsonb not null check (jsonb_typeof(approved_capabilities)='array'),
      config jsonb not null check (jsonb_typeof(config)='object'),
      primary key (tenant_id, room_id, plugin_id),
      foreign key (tenant_id, room_id) references rooms(tenant_id, room_id) on delete restrict,
      foreign key (tenant_id, room_id, package_id, plugin_id, version, artifact_sha256)
        references room_plugin_packages(tenant_id, room_id, package_id, plugin_id, version, artifact_sha256) on delete restrict
    );
    create or replace function room_plugin_package_immutable() returns trigger language plpgsql as $plugin$
    begin
      if (to_jsonb(new)-'state'-'upload_settled') is distinct from (to_jsonb(old)-'state'-'upload_settled') then
        raise exception 'plugin_package_immutable' using errcode='23514';
      end if;
      if new.upload_settled <> old.upload_settled and not (old.state='reserved' and not old.upload_settled and new.upload_settled) then
        raise exception 'plugin_invalid_transition' using errcode='23514';
      end if;
      if new.state <> old.state and not (
        (old.state='reserved' and new.state in ('ready','cleanup-pending')) or
        (old.state='ready' and new.state='cleanup-pending') or
        (old.state='cleanup-pending' and new.state='deleted')
      ) then raise exception 'plugin_invalid_transition' using errcode='23514'; end if;
      return new;
    end; $plugin$;
    drop trigger if exists room_plugin_package_immutable on room_plugin_packages;
    create trigger room_plugin_package_immutable before update on room_plugin_packages
      for each row execute function room_plugin_package_immutable();
  `);
}
