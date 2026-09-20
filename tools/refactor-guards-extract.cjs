const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require(process.env.TYPESCRIPT_PATH);
const root = process.argv[2];
const file = path.join(root, 'apps/api/src/storage.ts');
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const klass = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'PostgresStorage');
const names = ['ensureNamedForeignKey', 'installTemplateVersionImmutabilityTrigger'];
const methods = names.map(name => klass.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === name));
assert(methods.every(Boolean));
const helperStart = source.indexOf('const TEMPLATE_VERSION_MUTATION_FUNCTION_NAME =');
const helperEnd = source.indexOf('function roomNoteId(');
assert(helperStart > 0 && helperEnd > helperStart);
const helpers = source.slice(helperStart, helperEnd);
const literals = [];
function visit(n) {
  if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) literals.push([n.getStart(ast), n.end]);
  ts.forEachChild(n, visit);
}
visit(ast);
function functionText(n) {
  const start = source.lastIndexOf('\n', n.getStart(ast)) + 1;
  let offset = start;
  return source.slice(start, n.end).split('\n').map(line => {
    const insideLiteral = literals.some(([a, b]) => offset > a && offset < b);
    const edited = line.startsWith('  ') && !insideLiteral ? line.slice(2) : line;
    offset += line.length + 1;
    return edited;
  }).join('\n').replace(/^private async /, 'export async function ');
}
for (const m of methods) assert(!/\bthis\b/.test(m.body.getText(ast)));
const moved = methods.map(functionText);
let candidate = source;
for (const n of [...methods].reverse()) {
  const start = source.lastIndexOf('\n', n.getStart(ast)) + 1;
  assert(source.slice(n.end, n.end + 2) === '\n\n');
  candidate = candidate.slice(0, start) + candidate.slice(n.end + 2);
}
candidate = candidate.slice(0, helperStart) + candidate.slice(helperEnd);
for (const name of names) candidate = candidate.replaceAll(`this.${name}(`, `${name}(`);
const anchor = 'export { initPostgresStorageWithRetry }';
const imports = 'import { ensureNamedForeignKey, installTemplateVersionImmutabilityTrigger } from "./storage-postgres-guards.js";\n\n';
candidate = candidate.replace(anchor, imports + anchor);
const moduleText = 'import type { PoolClient } from "pg";\n\nimport { stableJson } from "./storage-room-records.js";\n\n' + helpers + moved.join('\n\n') + '\n';
const candidateAst = ts.createSourceFile(file, candidate, ts.ScriptTarget.Latest, true);
const moduleAst = ts.createSourceFile('storage-postgres-guards.ts', moduleText, ts.ScriptTarget.Latest, true);
assert.equal(candidateAst.parseDiagnostics.length, 0);
assert.equal(moduleAst.parseDiagnostics.length, 0);
const printer = ts.createPrinter({ removeComments: false });
for (let i = 0; i < methods.length; i++) {
  const fn = moduleAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === names[i]);
  assert.equal(printer.printNode(ts.EmitHint.Unspecified, methods[i].body, ast), printer.printNode(ts.EmitHint.Unspecified, fn.body, moduleAst));
}
const origLiterals = methods.map(n => {
  const values = [];
  function collect(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) values.push(node.getText(ast));
    ts.forEachChild(node, collect);
  }
  collect(n);
  return values;
});
const newLiterals = names.map(name => {
  const values = [];
  function collect(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) values.push(node.getText(moduleAst));
    ts.forEachChild(node, collect);
  }
  collect(moduleAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === name));
  return values;
});
assert.deepEqual(newLiterals, origLiterals);
fs.writeFileSync(file, candidate);
fs.writeFileSync(path.join(root, 'apps/api/src/storage-postgres-guards.ts'), moduleText);
console.log(JSON.stringify({ before: source.split('\n').length - 1, after: candidate.split('\n').length - 1, module: moduleText.split('\n').length - 1, methods: names, helperFunctions: 4, helperConstants: 2, allMovedBodiesIdentical: true, allQueryLiteralsIdentical: true }, null, 2));
