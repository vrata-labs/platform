import type { PoolClient } from "pg";

import { stableJson } from "./storage-room-records.js";

const TEMPLATE_VERSION_MUTATION_FUNCTION_NAME = "vrata_reject_template_version_mutation";
const TEMPLATE_VERSION_MUTATION_FUNCTION_SOURCE = `begin
  raise exception 'template_versions_are_immutable' using errcode = '55000';
  return null;
end`;

function normalizePostgresDefinition(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizePostgresConstraintDefinition(value: string): string {
  return normalizePostgresDefinition(value).replace(/ not valid$/, "");
}

function isExpectedTemplateVersionTriggerDefinition(value: string): boolean {
  const normalized = normalizePostgresDefinition(value).replaceAll('"', "");
  return /^create trigger template_versions_immutable before delete or update on (?:[a-z_][a-z0-9_]*\.)?template_versions for each row execute function (?:[a-z_][a-z0-9_]*\.)?vrata_reject_template_version_mutation\(\);?$/.test(normalized);
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function ensureNamedForeignKey(client: PoolClient, input: {
  tableRegclass: string;
  tableSql: string;
  constraintName: string;
  columns: string[];
  referencedTableRegclass: string;
  referencedColumns: string[];
  expectedDefinition: string;
  createSql: string;
}): Promise<void> {
  const result = await client.query(
    `select
         c.contype,
         c.convalidated,
         c.condeferrable,
         c.condeferred,
         c.confmatchtype,
         c.confupdtype,
         c.confdeltype,
         c.confrelid = $3::regclass as referenced_table_matches,
         pg_get_constraintdef(c.oid, true) as definition,
         (select array_agg(a.attname::text order by key.ordinality)
            from unnest(c.conkey) with ordinality as key(attnum, ordinality)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = key.attnum) as columns,
         (select array_agg(a.attname::text order by key.ordinality)
            from unnest(c.confkey) with ordinality as key(attnum, ordinality)
            join pg_attribute a on a.attrelid = c.confrelid and a.attnum = key.attnum) as referenced_columns
       from pg_constraint c
       where c.conrelid = $1::regclass and c.conname = $2`,
    [input.tableRegclass, input.constraintName, input.referencedTableRegclass]
  );
  const row = result.rows[0] as {
    contype: string;
    convalidated: boolean;
    condeferrable: boolean;
    condeferred: boolean;
    confmatchtype: string;
    confupdtype: string;
    confdeltype: string;
    referenced_table_matches: boolean;
    definition: string;
    columns: string[];
    referenced_columns: string[];
  } | undefined;
  if (row && (
    row.contype !== "f"
    || row.condeferrable
    || row.condeferred
    || row.confmatchtype !== "s"
    || row.confupdtype !== "a"
    || row.confdeltype !== "a"
    || !row.referenced_table_matches
    || stableJson(row.columns) !== stableJson(input.columns)
    || stableJson(row.referenced_columns) !== stableJson(input.referencedColumns)
    || normalizePostgresConstraintDefinition(row.definition) !== normalizePostgresConstraintDefinition(input.expectedDefinition)
  )) {
    throw new Error(`postgres_constraint_definition_mismatch:${input.tableRegclass}.${input.constraintName}:${stableJson(row)}`);
  }
  if (!row) {
    await client.query(input.createSql);
  }
  if (!row?.convalidated) {
    await client.query(`alter table ${input.tableSql} validate constraint ${input.constraintName}`);
  }
}

export async function installTemplateVersionImmutabilityTrigger(client: PoolClient): Promise<void> {
  const schemaResult = await client.query(`
      select n.nspname as table_schema
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.oid = 'template_versions'::regclass
    `);
  const tableSchema = schemaResult.rows[0]?.table_schema as string | undefined;
  if (!tableSchema) throw new Error("postgres_table_schema_not_found:template_versions");
  const quotedTableSchema = quotePostgresIdentifier(tableSchema);
  const functionResult = await client.query(
    `select
         p.prorettype::regtype::text as return_type,
         l.lanname as language,
         p.prosrc as source,
         p.prosecdef as security_definer,
         p.provolatile as volatility,
         p.proleakproof as leakproof,
         p.proparallel as parallel_safety,
         p.proisstrict as strict,
         p.proconfig as runtime_config,
         pg_get_functiondef(p.oid) as definition
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_language l on l.oid = p.prolang
       where n.nspname = $2
          and p.proname = $1
          and p.pronargs = 0`,
    [TEMPLATE_VERSION_MUTATION_FUNCTION_NAME, tableSchema]
  );
  const functionRow = functionResult.rows[0] as {
    return_type: string;
    language: string;
    source: string;
    security_definer: boolean;
    volatility: string;
    leakproof: boolean;
    parallel_safety: string;
    strict: boolean;
    runtime_config: string[] | null;
    definition: string;
  } | undefined;
  if (functionRow && (
    functionRow.return_type !== "trigger"
    || functionRow.language !== "plpgsql"
    || functionRow.security_definer
    || functionRow.volatility !== "v"
    || functionRow.leakproof
    || functionRow.parallel_safety !== "u"
    || functionRow.strict
    || functionRow.runtime_config !== null
    || normalizePostgresDefinition(functionRow.source) !== normalizePostgresDefinition(TEMPLATE_VERSION_MUTATION_FUNCTION_SOURCE)
  )) {
    throw new Error(`postgres_function_definition_mismatch:${tableSchema}.${TEMPLATE_VERSION_MUTATION_FUNCTION_NAME}:${functionRow.definition}`);
  }
  if (!functionRow) {
    await client.query(`
        create function ${quotedTableSchema}.vrata_reject_template_version_mutation()
        returns trigger
        language plpgsql
        as $vrata_function$
        begin
          raise exception 'template_versions_are_immutable' using errcode = '55000';
          return null;
        end
        $vrata_function$
      `);
  }

  const triggerResult = await client.query(
    `select
         t.tgtype::integer as trigger_type,
         t.tgenabled,
         t.tgqual is null as has_no_when,
         t.tgattr::text = '' as all_columns,
         fn.proname as function_name,
         fn.pronargs as function_arg_count,
         fn_ns.nspname as function_schema,
         pg_get_triggerdef(t.oid, true) as definition
       from pg_trigger t
       join pg_proc fn on fn.oid = t.tgfoid
       join pg_namespace fn_ns on fn_ns.oid = fn.pronamespace
       where t.tgrelid = 'template_versions'::regclass
         and t.tgname = 'template_versions_immutable'
         and not t.tgisinternal`
  );
  const triggerRow = triggerResult.rows[0] as {
    trigger_type: number;
    tgenabled: string;
    has_no_when: boolean;
    all_columns: boolean;
    function_name: string;
    function_arg_count: number;
    function_schema: string;
    definition: string;
  } | undefined;
  if (triggerRow && (
    triggerRow.trigger_type !== 27
    || triggerRow.tgenabled !== "O"
    || !triggerRow.has_no_when
    || !triggerRow.all_columns
    || triggerRow.function_schema !== tableSchema
    || triggerRow.function_name !== TEMPLATE_VERSION_MUTATION_FUNCTION_NAME
    || triggerRow.function_arg_count !== 0
    || !isExpectedTemplateVersionTriggerDefinition(triggerRow.definition)
  )) {
    throw new Error(`postgres_trigger_definition_mismatch:template_versions.template_versions_immutable:${triggerRow.definition}`);
  }
  if (!triggerRow) {
    await client.query(`
        create trigger template_versions_immutable
          before update or delete on template_versions
          for each row execute function ${quotedTableSchema}.vrata_reject_template_version_mutation()
      `);
  }
}
