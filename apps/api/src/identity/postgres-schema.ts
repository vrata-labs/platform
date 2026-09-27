import type { PoolClient } from "pg";

const guards = [
  { table: "room_identities_v2", name: "vrata_identity_v2_immutable", body: `BEGIN
    IF ROW(NEW.tenant_id, NEW.room_id, NEW.identity_id, NEW.participant_id, NEW.base_role, NEW.provenance, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.room_id, OLD.identity_id, OLD.participant_id, OLD.base_role, OLD.provenance, OLD.created_at)
      OR NEW.auth_epoch < OLD.auth_epoch OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    THEN RAISE EXCEPTION 'immutable_room_identity' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END;` },
  { table: "room_identity_recoveries_v2", name: "vrata_identity_recovery_v2_immutable", body: `BEGIN
    IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
      OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
    THEN RAISE EXCEPTION 'immutable_identity_recovery' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END;` },
  { table: "room_identity_authority_v2", name: "vrata_identity_authority_v2_monotonic", body: `BEGIN
    IF ROW(NEW.tenant_id, NEW.room_id) IS DISTINCT FROM ROW(OLD.tenant_id, OLD.room_id)
      OR NEW.revision < OLD.revision
      OR (ROW(NEW.host_identity_id, NEW.owner_identity_id, NEW.presenter_identity_id)
        IS DISTINCT FROM ROW(OLD.host_identity_id, OLD.owner_identity_id, OLD.presenter_identity_id) AND NEW.revision <= OLD.revision)
    THEN RAISE EXCEPTION 'nonmonotonic_identity_authority' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END;` },
  { table: "rooms", name: "vrata_identity_v2_room_boundary", body: `DECLARE bound boolean;
  BEGIN
    IF ROW(NEW.tenant_id, NEW.room_type, NEW.owner_participant_id, NEW.session_control)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.room_type, OLD.owner_participant_id, OLD.session_control) THEN
      EXECUTE format('select exists(select 1 from %I.room_identity_authority_v2 where tenant_id=$1 and room_id=$2)', TG_TABLE_SCHEMA)
        INTO bound USING OLD.tenant_id, OLD.room_id;
      IF bound THEN RAISE EXCEPTION 'room_identity_lifecycle_requires_v2' USING ERRCODE = '23514'; END IF;
    END IF;
    RETURN NEW;
  END;` }
].map(guard => {
  const protectDelete = guard.table === "room_identities_v2" || guard.table === "room_identity_authority_v2";
  return { ...guard, events: protectDelete ? "delete or update" : "update", triggerType: protectDelete ? 27 : 19,
    body: protectDelete ? `DECLARE parent_exists boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        EXECUTE format('select exists(select 1 from %I.rooms where tenant_id=$1 and room_id=$2)', TG_TABLE_SCHEMA)
          INTO parent_exists USING OLD.tenant_id, OLD.room_id;
        IF parent_exists THEN RAISE EXCEPTION 'identity_namespace_requires_room_delete' USING ERRCODE = '23514'; END IF;
        RETURN OLD;
      END IF;
      ${guard.body}
    END;` : guard.body };
});

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const roomForeignKey = "FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, room_id) ON DELETE CASCADE";
const identityForeignKey = (column: string) => `FOREIGN KEY (tenant_id, room_id, ${column}) REFERENCES room_identities_v2(tenant_id, room_id, identity_id) DEFERRABLE INITIALLY DEFERRED`;
// PostgreSQL 16 canonical definitions. Do not silently accept weaker constraints
// left by a partial/older schema merely because CREATE IF NOT EXISTS succeeded.
const constraints = [
  ["room_identities_v2", "identity_v2_pk", "PRIMARY KEY (tenant_id, room_id, identity_id)"],
  ["room_identities_v2", "identity_v2_participant", "UNIQUE (tenant_id, room_id, participant_id)"],
  ["room_identities_v2", "identity_v2_room", roomForeignKey],
  ["room_identities_v2", "identity_v2_name", "CHECK ((char_length(display_name) <= 80))"],
  ["room_identities_v2", "identity_v2_role", "CHECK ((base_role = ANY (ARRAY['guest'::text, 'member'::text])))"],
  ["room_identities_v2", "identity_v2_provenance", "CHECK ((jsonb_typeof(provenance) = 'object'::text))"],
  ["room_identities_v2", "identity_v2_epoch", "CHECK ((auth_epoch >= 1))"],
  ["room_identity_authority_v2", "authority_v2_pk", "PRIMARY KEY (tenant_id, room_id)"],
  ["room_identity_authority_v2", "authority_v2_room", roomForeignKey],
  ["room_identity_authority_v2", "authority_v2_revision", "CHECK ((revision >= 0))"],
  ...["host", "owner", "presenter"].map(slot => ["room_identity_authority_v2", `authority_v2_${slot}`, identityForeignKey(`${slot}_identity_id`)]),
  ["room_identity_recoveries_v2", "recovery_v2_pk", "PRIMARY KEY (tenant_id, room_id, recovery_id)"],
  ["room_identity_recoveries_v2", "recovery_v2_room", roomForeignKey],
  ["room_identity_recoveries_v2", "recovery_v2_target", identityForeignKey("target_identity_id")],
  ["room_identity_recoveries_v2", "recovery_v2_role", "CHECK ((target_role = ANY (ARRAY['host'::text, 'owner'::text])))"],
  ["room_identity_recoveries_v2", "recovery_v2_epoch", "CHECK ((expected_auth_epoch >= 1))"],
  ["room_identity_recoveries_v2", "recovery_v2_revision", "CHECK ((expected_authority_revision >= 0))"],
  ["room_identity_recoveries_v2", "recovery_v2_hash", "CHECK ((secret_hash ~ '^[a-f0-9]{64}$'::text))"],
  ["room_identity_recoveries_v2", "recovery_v2_lifetime", "CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:15:00'::interval))))"],
  ["room_identity_recoveries_v2", "recovery_v2_target_epoch", "CHECK (((target_identity_id IS NULL) = (expected_auth_epoch IS NULL)))"]
];

const columns = [
  ...["tenant_id", "room_id", "identity_id", "participant_id", "display_name", "base_role"].map(name => ["room_identities_v2", name, "text", true]),
  ["room_identities_v2", "provenance", "jsonb", true], ["room_identities_v2", "auth_epoch", "integer", true],
  ["room_identities_v2", "created_at", "timestamp with time zone", true], ["room_identities_v2", "revoked_at", "timestamp with time zone", false],
  ...["tenant_id", "room_id"].map(name => ["room_identity_authority_v2", name, "text", true]),
  ...["host_identity_id", "owner_identity_id", "presenter_identity_id"].map(name => ["room_identity_authority_v2", name, "text", false]),
  ["room_identity_authority_v2", "revision", "integer", true],
  ...["tenant_id", "room_id", "recovery_id", "target_participant_id", "target_role", "secret_hash", "issued_by"].map(name => ["room_identity_recoveries_v2", name, "text", true]),
  ["room_identity_recoveries_v2", "target_identity_id", "text", false],
  ["room_identity_recoveries_v2", "expected_auth_epoch", "integer", false],
  ["room_identity_recoveries_v2", "expected_authority_revision", "integer", true],
  ...["created_at", "expires_at"].map(name => ["room_identity_recoveries_v2", name, "timestamp with time zone", true]),
  ["room_identity_recoveries_v2", "consumed_at", "timestamp with time zone", false]
];

export async function installRoomIdentitySchema(client: PoolClient): Promise<void> {
  await client.query(`
    create unique index if not exists rooms_identity_scope_idx on rooms (tenant_id, room_id);
    create table if not exists room_identities_v2 (
      tenant_id text not null, room_id text not null, identity_id text not null,
      participant_id text not null, display_name text not null constraint identity_v2_name check (char_length(display_name) <= 80),
      base_role text not null constraint identity_v2_role check (base_role in ('guest', 'member')),
      provenance jsonb not null constraint identity_v2_provenance check (jsonb_typeof(provenance) = 'object'),
      auth_epoch integer not null constraint identity_v2_epoch check (auth_epoch >= 1),
      created_at timestamptz not null, revoked_at timestamptz,
      constraint identity_v2_pk primary key (tenant_id, room_id, identity_id),
      constraint identity_v2_participant unique (tenant_id, room_id, participant_id),
      constraint identity_v2_room foreign key (tenant_id, room_id) references rooms(tenant_id, room_id) on delete cascade
    );
    create table if not exists room_identity_authority_v2 (
      tenant_id text not null, room_id text not null, revision integer not null constraint authority_v2_revision check (revision >= 0),
      host_identity_id text, owner_identity_id text, presenter_identity_id text,
      constraint authority_v2_pk primary key (tenant_id, room_id),
      constraint authority_v2_room foreign key (tenant_id, room_id) references rooms(tenant_id, room_id) on delete cascade,
      constraint authority_v2_host foreign key (tenant_id, room_id, host_identity_id) references room_identities_v2(tenant_id, room_id, identity_id) deferrable initially deferred,
      constraint authority_v2_owner foreign key (tenant_id, room_id, owner_identity_id) references room_identities_v2(tenant_id, room_id, identity_id) deferrable initially deferred,
      constraint authority_v2_presenter foreign key (tenant_id, room_id, presenter_identity_id) references room_identities_v2(tenant_id, room_id, identity_id) deferrable initially deferred
    );
    create table if not exists room_identity_recoveries_v2 (
      tenant_id text not null, room_id text not null, recovery_id text not null,
      target_participant_id text not null, target_identity_id text,
      target_role text not null constraint recovery_v2_role check (target_role in ('host', 'owner')),
      expected_auth_epoch integer constraint recovery_v2_epoch check (expected_auth_epoch >= 1),
      expected_authority_revision integer not null constraint recovery_v2_revision check (expected_authority_revision >= 0),
      secret_hash text not null constraint recovery_v2_hash check (secret_hash ~ '^[a-f0-9]{64}$'), issued_by text not null,
      created_at timestamptz not null, expires_at timestamptz not null, consumed_at timestamptz,
      constraint recovery_v2_lifetime check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
      constraint recovery_v2_target_epoch check ((target_identity_id is null) = (expected_auth_epoch is null)),
      constraint recovery_v2_pk primary key (tenant_id, room_id, recovery_id),
      constraint recovery_v2_room foreign key (tenant_id, room_id) references rooms(tenant_id, room_id) on delete cascade,
      constraint recovery_v2_target foreign key (tenant_id, room_id, target_identity_id) references room_identities_v2(tenant_id, room_id, identity_id) deferrable initially deferred
    );
    do $guard$
    declare guard record; function_oid oid; table_schema text;
    begin
      if not exists (select 1 from pg_index i where i.indexrelid=to_regclass('rooms_identity_scope_idx') and i.indrelid='rooms'::regclass
        and i.indisunique and i.indisvalid and i.indisready and i.indpred is null and i.indexprs is null and i.indnkeyatts=2
        and i.indkey[0]=(select attnum from pg_attribute where attrelid='rooms'::regclass and attname='tenant_id')
        and i.indkey[1]=(select attnum from pg_attribute where attrelid='rooms'::regclass and attname='room_id')) then
        raise exception 'room_identity_schema_mismatch';
      end if;
      for guard in select * from (values ${constraints.map(row => `(${row.map(literal).join(",")})`).join(",")}) as c(table_name,constraint_name,definition) loop
        if not exists (select 1 from pg_constraint c where c.conrelid=to_regclass(guard.table_name) and c.conname=guard.constraint_name
          and c.convalidated and pg_get_constraintdef(c.oid)=guard.definition) then
          raise exception 'room_identity_schema_mismatch';
        end if;
      end loop;
      for guard in select * from (values ${columns.map(row => `(${row.map(value => typeof value === "boolean" ? String(value) : literal(String(value))).join(",")})`).join(",")}) as a(table_name,column_name,type_name,not_null) loop
        if not exists (select 1 from pg_attribute a where a.attrelid=to_regclass(guard.table_name) and a.attname=guard.column_name
          and not a.attisdropped and a.atttypid=guard.type_name::regtype and a.attnotnull=guard.not_null and a.atttypmod=-1) then
          raise exception 'room_identity_schema_mismatch';
        end if;
      end loop;
      for guard in select * from (values ${guards.map(guard => `(${literal(guard.table)},${literal(guard.name)},${literal(guard.body)},${literal(guard.events)},${guard.triggerType})`).join(",")}) as g(table_name,function_name,body,events,trigger_type) loop
        select n.nspname into table_schema from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=to_regclass(guard.table_name);
        select p.oid into function_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname=table_schema and p.proname=guard.function_name and p.pronargs=0;
        if function_oid is null then
          execute format('create function %I.%I() returns trigger language plpgsql as %L', table_schema,guard.function_name,guard.body);
          function_oid := to_regprocedure(format('%I.%I()',table_schema,guard.function_name));
        elsif not exists (select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=function_oid
          and p.prosrc=guard.body and p.prorettype='trigger'::regtype and l.lanname='plpgsql'
          and not p.prosecdef and not p.proleakproof and not p.proisstrict and p.provolatile='v' and p.proparallel='u' and p.proconfig is null) then
          raise exception 'room_identity_guard_mismatch';
        end if;
        if not exists (select 1 from pg_trigger where tgrelid=to_regclass(guard.table_name) and tgname=guard.function_name) then
          execute format('create trigger %I before %s on %I.%I for each row execute function %I.%I()', guard.function_name,guard.events,table_schema,guard.table_name,table_schema,guard.function_name);
        elsif not exists (select 1 from pg_trigger where tgrelid=to_regclass(guard.table_name) and tgname=guard.function_name
          and tgfoid=function_oid and tgtype=guard.trigger_type and tgenabled='O' and tgqual is null and tgattr=''::int2vector and tgnargs=0) then
          raise exception 'room_identity_guard_mismatch';
        end if;
      end loop;
    end; $guard$;
  `);
}
