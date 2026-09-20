import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";

import { ensureNamedForeignKey, installTemplateVersionImmutabilityTrigger } from "./storage-postgres-guards.js";

type Row = Record<string, unknown>;
type Reply = Row[] | Error | (() => Promise<{ rows: Row[] }>);

function scriptedClient(replies: Reply[]) {
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    query(sql: string, values?: unknown[]) {
      assert.equal(this, client, "queries must retain the client receiver");
      queries.push({ sql, values });
      assert.ok(replies.length, "unexpected extra query");
      const reply = replies.shift()!;
      if (reply instanceof Error) return Promise.reject(reply);
      return typeof reply === "function" ? reply() : Promise.resolve({ rows: reply });
    }
  };
  return { client: client as unknown as PoolClient, queries, replies };
}

function foreignKeyInput(): Parameters<typeof ensureNamedForeignKey>[1] {
  return {
    tableRegclass: "rooms",
    tableSql: '"rooms"',
    constraintName: "rooms_template_version_fkey",
    columns: ["template_id", "template_version"],
    referencedTableRegclass: "template_versions",
    referencedColumns: ["template_id", "version"],
    expectedDefinition: "foreign key (template_id, template_version) references template_versions(template_id, version)",
    createSql: "alter table rooms add constraint rooms_template_version_fkey foreign key (template_id, template_version) references template_versions(template_id, version) not valid"
  };
}

function validForeignKey(): Row {
  return {
    contype: "f", convalidated: true, condeferrable: false, condeferred: false,
    confmatchtype: "s", confupdtype: "a", confdeltype: "a", referenced_table_matches: true,
    definition: foreignKeyInput().expectedDefinition,
    columns: ["template_id", "template_version"], referenced_columns: ["template_id", "version"]
  };
}

function validFunction(): Row {
  return {
    return_type: "trigger", language: "plpgsql",
    source: "begin raise exception 'template_versions_are_immutable' using errcode = '55000'; return null; end",
    security_definer: false, volatility: "v", leakproof: false,
    parallel_safety: "u", strict: false, runtime_config: null,
    definition: "existing function definition"
  };
}

function validTrigger(schema = "public"): Row {
  return {
    trigger_type: 27, tgenabled: "O", has_no_when: true, all_columns: true,
    function_name: "vrata_reject_template_version_mutation", function_arg_count: 0,
    function_schema: schema,
    definition: `CREATE TRIGGER template_versions_immutable BEFORE DELETE OR UPDATE ON ${schema}.template_versions FOR EACH ROW EXECUTE FUNCTION ${schema}.vrata_reject_template_version_mutation()`
  };
}

function normalized(sql: string): string { return sql.replace(/\s+/g, " ").trim(); }

const validateSql = 'alter table "rooms" validate constraint rooms_template_version_fkey';

test("foreign key guard creates an absent constraint before validating it", async () => {
  const fake = scriptedClient([[], [], []]);
  const input = foreignKeyInput();
  const before = structuredClone(input);
  assert.equal(await ensureNamedForeignKey(fake.client, input), undefined);
  assert.match(fake.queries[0].sql, /from pg_constraint c/);
  assert.deepEqual(fake.queries[0].values, ["rooms", "rooms_template_version_fkey", "template_versions"]);
  assert.deepEqual(fake.queries.slice(1), [{ sql: input.createSql, values: undefined }, { sql: validateSql, values: undefined }]);
  assert.deepEqual(input, before);
  assert.equal(fake.replies.length, 0);
});

test("foreign key guard leaves a matching validated constraint untouched", async () => {
  const fake = scriptedClient([[validForeignKey()]]);
  await ensureNamedForeignKey(fake.client, foreignKeyInput());
  assert.equal(fake.queries.length, 1);
});

test("foreign key guard validates matching NOT VALID constraints without recreating them", async () => {
  const row = { ...validForeignKey(), convalidated: false, definition: `  ${foreignKeyInput().expectedDefinition.toUpperCase()}\n NOT   VALID  ` };
  const before = structuredClone(row);
  const fake = scriptedClient([[row], []]);
  await ensureNamedForeignKey(fake.client, foreignKeyInput());
  assert.deepEqual(fake.queries.slice(1), [{ sql: validateSql, values: undefined }]);
  assert.deepEqual(row, before);
});

const badForeignKeyFields: Row = {
  contype: "p", condeferrable: true, condeferred: true, confmatchtype: "f",
  confupdtype: "c", confdeltype: "c", referenced_table_matches: false,
  columns: ["template_version", "template_id"], referenced_columns: ["version", "template_id"],
  definition: "foreign key (template_id) references tenants(tenant_id)"
};
for (const [field, value] of Object.entries(badForeignKeyFields)) {
  test(`foreign key guard rejects mismatched ${field} before any DDL`, async () => {
    const row = { ...validForeignKey(), [field]: value };
    const fake = scriptedClient([[row]]);
    const serialized = JSON.stringify(row, Object.keys(row).sort());
    await assert.rejects(ensureNamedForeignKey(fake.client, foreignKeyInput()), {
      message: `postgres_constraint_definition_mismatch:rooms.rooms_template_version_fkey:${serialized}`
    });
    assert.equal(fake.queries.length, 1);
  });
}

for (const [label, replies] of [
  ["catalog read", []], ["creation", [[]]], ["validation", [[], []]]
] as Array<[string, Reply[]]>) {
  test(`foreign key guard preserves the original ${label} error and stops`, async () => {
    const error = new Error(label);
    const fake = scriptedClient([...replies, error]);
    await assert.rejects(ensureNamedForeignKey(fake.client, foreignKeyInput()), (actual: unknown) => actual === error);
    assert.equal(fake.queries.length, replies.length + 1);
  });
}

test("foreign key guard does not validate until constraint creation resolves", async () => {
  let resolveCreate!: (result: { rows: Row[] }) => void;
  const creation = new Promise<{ rows: Row[] }>((resolve) => { resolveCreate = resolve; });
  const fake = scriptedClient([[], () => creation, []]);
  const work = ensureNamedForeignKey(fake.client, foreignKeyInput());
  await Promise.resolve();
  assert.equal(fake.queries.length, 2);
  resolveCreate({ rows: [] });
  await work;
  assert.equal(fake.queries[2].sql, validateSql);
});

test("immutability guard creates the function before looking up and creating the trigger", async () => {
  const fake = scriptedClient([[{ table_schema: "custom_schema" }], [], [], [], []]);
  assert.equal(await installTemplateVersionImmutabilityTrigger(fake.client), undefined);
  assert.equal(fake.queries.length, 5);
  assert.match(fake.queries[0].sql, /'template_versions'::regclass/);
  assert.deepEqual(fake.queries[1].values, ["vrata_reject_template_version_mutation", "custom_schema"]);
  assert.match(normalized(fake.queries[2].sql), /^create function "custom_schema"\.vrata_reject_template_version_mutation\(\) returns trigger language plpgsql/);
  assert.match(fake.queries[2].sql, /raise exception 'template_versions_are_immutable' using errcode = '55000';/);
  assert.match(fake.queries[3].sql, /from pg_trigger t/);
  assert.match(normalized(fake.queries[4].sql), /^create trigger template_versions_immutable before update or delete on template_versions for each row execute function "custom_schema"\.vrata_reject_template_version_mutation\(\)$/);
  assert.ok(fake.queries.filter((_, index) => index !== 1).every(query => query.values === undefined));
});

test("immutability guard preserves a matching function and trigger without DDL", async () => {
  const fn = validFunction();
  const trigger = validTrigger();
  const before = structuredClone({ fn, trigger });
  const fake = scriptedClient([[{ table_schema: "public" }], [fn], [trigger]]);
  await installTemplateVersionImmutabilityTrigger(fake.client);
  assert.equal(fake.queries.length, 3);
  assert.deepEqual({ fn, trigger }, before);
});

test("immutability guard creates only the trigger when its function already exists", async () => {
  const fake = scriptedClient([[{ table_schema: "public" }], [validFunction()], [], []]);
  await installTemplateVersionImmutabilityTrigger(fake.client);
  assert.equal(fake.queries.length, 4);
  assert.match(normalized(fake.queries[3].sql), /^create trigger /);
  assert.ok(fake.queries.every(query => !normalized(query.sql).startsWith("create function")));
});

test("immutability guard escapes schema identifiers but preserves the catalog parameter", async () => {
  const schema = 'space " and quote';
  const fake = scriptedClient([[{ table_schema: schema }], [], [], [], []]);
  await installTemplateVersionImmutabilityTrigger(fake.client);
  assert.equal(fake.queries[1].values?.[1], schema);
  assert.ok(fake.queries[2].sql.includes('"space "" and quote".vrata_reject_template_version_mutation()'));
  assert.ok(fake.queries[4].sql.includes('"space "" and quote".vrata_reject_template_version_mutation()'));
});

for (const rows of [[], [{}], [{ table_schema: "" }]]) {
  test(`immutability guard rejects an unresolved schema: ${JSON.stringify(rows)}`, async () => {
    const fake = scriptedClient([rows]);
    await assert.rejects(installTemplateVersionImmutabilityTrigger(fake.client), { message: "postgres_table_schema_not_found:template_versions" });
    assert.equal(fake.queries.length, 1);
  });
}

const badFunctionFields: Row = {
  return_type: "void", language: "sql", source: "begin return null; end", security_definer: true,
  volatility: "s", leakproof: true, parallel_safety: "s", strict: true, runtime_config: []
};
for (const [field, value] of Object.entries(badFunctionFields)) {
  test(`immutability guard rejects mismatched function ${field} without replacement`, async () => {
    const fake = scriptedClient([[{ table_schema: "public" }], [{ ...validFunction(), [field]: value }]]);
    await assert.rejects(installTemplateVersionImmutabilityTrigger(fake.client), {
      message: "postgres_function_definition_mismatch:public.vrata_reject_template_version_mutation:existing function definition"
    });
    assert.equal(fake.queries.length, 2);
  });
}

const badTriggerFields: Row = {
  trigger_type: 19, tgenabled: "D", has_no_when: false, all_columns: false,
  function_schema: "other_schema", function_name: "other_function", function_arg_count: 1,
  definition: "CREATE TRIGGER template_versions_immutable BEFORE UPDATE ON template_versions"
};
for (const [field, value] of Object.entries(badTriggerFields)) {
  test(`immutability guard rejects mismatched trigger ${field} without replacement`, async () => {
    const row = { ...validTrigger(), [field]: value };
    const fake = scriptedClient([[{ table_schema: "public" }], [validFunction()], [row]]);
    await assert.rejects(installTemplateVersionImmutabilityTrigger(fake.client), {
      message: `postgres_trigger_definition_mismatch:template_versions.template_versions_immutable:${row.definition}`
    });
    assert.equal(fake.queries.length, 3);
  });
}

for (const definition of [
  ' CREATE TRIGGER "template_versions_immutable" BEFORE DELETE OR UPDATE ON "public"."template_versions" FOR EACH ROW EXECUTE FUNCTION "public"."vrata_reject_template_version_mutation"(); ',
  "create trigger template_versions_immutable before delete or update on template_versions for each row execute function vrata_reject_template_version_mutation()"
]) {
  test(`immutability guard accepts normalized trigger definition: ${definition.trim()}`, async () => {
    const fn = { ...validFunction(), source: `\n  ${String(validFunction().source).toUpperCase()}  \n` };
    const fake = scriptedClient([[{ table_schema: "public" }], [fn], [{ ...validTrigger(), definition }]]);
    await installTemplateVersionImmutabilityTrigger(fake.client);
    assert.equal(fake.queries.length, 3);
  });
}

for (const [label, replies] of [
  ["schema read", []], ["function read", [[{ table_schema: "public" }]]],
  ["function creation", [[{ table_schema: "public" }], []]],
  ["trigger read", [[{ table_schema: "public" }], [validFunction()]]],
  ["trigger creation", [[{ table_schema: "public" }], [validFunction()], []]]
] as Array<[string, Reply[]]>) {
  test(`immutability guard preserves the original ${label} error and stops`, async () => {
    const error = new Error(label);
    const fake = scriptedClient([...replies, error]);
    await assert.rejects(installTemplateVersionImmutabilityTrigger(fake.client), (actual: unknown) => actual === error);
    assert.equal(fake.queries.length, replies.length + 1);
  });
}

test("immutability guard waits for function creation before reading the trigger", async () => {
  let resolveCreate!: (result: { rows: Row[] }) => void;
  const creation = new Promise<{ rows: Row[] }>((resolve) => { resolveCreate = resolve; });
  const fake = scriptedClient([[{ table_schema: "public" }], [], () => creation, [], []]);
  const work = installTemplateVersionImmutabilityTrigger(fake.client);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fake.queries.length, 3);
  resolveCreate({ rows: [] });
  await work;
  assert.match(fake.queries[3].sql, /from pg_trigger t/);
});
