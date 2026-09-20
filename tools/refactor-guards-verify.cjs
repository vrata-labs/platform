const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const ts = require(process.env.TYPESCRIPT_PATH);
const [baselineDir, candidateDir, mode = 'source'] = process.argv.slice(2);
const ext = mode === 'compiled' ? '.js' : '.ts';
const old = fs.readFileSync(path.join(baselineDir, 'storage' + ext), 'utf8');
const now = fs.readFileSync(path.join(candidateDir, 'storage' + ext), 'utf8');
const extracted = fs.readFileSync(path.join(candidateDir, 'storage-postgres-guards' + ext), 'utf8');
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ext === '.js' ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const a = parse('original' + ext, old), b = parse('candidate' + ext, now), c = parse('extracted' + ext, extracted);
for (const ast of [a, b, c]) assert.equal(ast.parseDiagnostics.length, 0);
const methods = ['ensureNamedForeignKey', 'installTemplateVersionImmutabilityTrigger'];
const helpers = ['TEMPLATE_VERSION_MUTATION_FUNCTION_NAME', 'TEMPLATE_VERSION_MUTATION_FUNCTION_SOURCE', 'normalizePostgresDefinition', 'normalizePostgresConstraintDefinition', 'isExpectedTemplateVersionTriggerDefinition', 'quotePostgresIdentifier'];
const getName = n => n.name?.getText() || (ts.isVariableStatement(n) ? n.declarationList.declarations[0].name.getText() : '');
const print = ts.createPrinter({ removeComments: false });
const canonical = (n, ast) => print.printNode(ts.EmitHint.Unspecified, n, ast);
const originalClass = a.statements.find(n => ts.isClassDeclaration(n) && getName(n) === 'PostgresStorage');
const candidateClass = b.statements.find(n => ts.isClassDeclaration(n) && getName(n) === 'PostgresStorage');
function undoCalls(text) {
  for (const name of methods) text = text.replaceAll(`this.${name}(`, `${name}(`);
  return text;
}
let methodCount = 0;
for (const n of originalClass.members) {
  if (methods.includes(getName(n))) {
    const fn = c.statements.find(f => ts.isFunctionDeclaration(f) && getName(f) === getName(n));
    assert(fn);
    assert.equal(canonical(n.body, a), canonical(fn.body, c));
    assert.deepEqual(n.parameters.map(p => canonical(p, a)), fn.parameters.map(p => canonical(p, c)));
  } else {
    const other = candidateClass.members.find(f => getName(f) === getName(n) && f.kind === n.kind);
    assert(other, 'missing member ' + getName(n));
    assert.equal(undoCalls(canonical(n, a)), canonical(other, b));
    methodCount++;
  }
}
assert.equal(candidateClass.members.length, originalClass.members.length - methods.length);
for (const name of helpers) {
  const left = a.statements.find(n => getName(n) === name), right = c.statements.find(n => getName(n) === name);
  assert(left && right, name);
  assert.equal(canonical(left, a), canonical(right, c));
}
const originalOther = a.statements.filter(n => !helpers.includes(getName(n)) && n !== originalClass);
const candidateOther = b.statements.filter(n => n !== candidateClass && !(ts.isImportDeclaration(n) && n.moduleSpecifier.text === './storage-postgres-guards.js'));
assert.deepEqual(originalOther.map(n => canonical(n, a)), candidateOther.map(n => canonical(n, b)));
let unchangedJs = 0, existingJs = 0;
if (mode === 'compiled') {
  for (const name of fs.readdirSync(baselineDir).filter(n => n.endsWith('.js') && n !== 'storage-postgres-guards.js' && n !== 'storage-postgres-guards.test.js')) {
    existingJs++;
    if (name !== 'storage.js') {
      assert.deepEqual(fs.readFileSync(path.join(baselineDir, name)), fs.readFileSync(path.join(candidateDir, name)), name);
      unchangedJs++;
    }
  }
  let allowed = fs.readFileSync(path.join(baselineDir, 'storage.d.ts'), 'utf8');
  for (const name of methods) allowed = allowed.replace(new RegExp(`^    private ${name};\\n`, 'm'), '');
  assert.equal(allowed, fs.readFileSync(path.join(candidateDir, 'storage.d.ts'), 'utf8'), 'public declarations changed beyond removed private methods');
  const originalMethods = methods.map(name => originalClass.members.find(n => getName(n) === name).getText(a)).join('\n');
  const originalHelpers = a.statements.filter(n => helpers.includes(getName(n))).map(n => n.getText(a)).join('\n');
  const harness = `import { stableJson } from "./storage-room-records.js";\n${originalHelpers}\nclass OriginalGuards {\n${originalMethods}\n}\nconst original = new OriginalGuards();\n${methods.map(n => `export const ${n} = original.${n}.bind(original);`).join('\n')}\n`;
  fs.writeFileSync(path.join(baselineDir, 'storage-postgres-guards.js'), harness);
  fs.copyFileSync(path.join(candidateDir, 'storage-postgres-guards.test.js'), path.join(baselineDir, 'storage-postgres-guards.test.js'));
  fs.writeFileSync(path.join(baselineDir, 'package.json'), '{"type":"module"}\n');
}
console.log(JSON.stringify({ mode, movedMethods: methods, helpersPreserved: helpers.length, remainingClassMembers: methodCount, remainingTopLevelStatements: originalOther.length, sqlAndBodiesIdentical: true, existingJs, unchangedJs, publicDeclarationsPreserved: true }, null, 2));
