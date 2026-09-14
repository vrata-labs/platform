const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const [beforePath, afterPath, modulePath, outputPath] = process.argv.slice(2);
const beforeText = fs.readFileSync(beforePath, 'utf8');
const afterText = fs.readFileSync(afterPath, 'utf8');
const moduleText = fs.readFileSync(modulePath, 'utf8');
const parse = (text) => ts.createSourceFile('input.ts', text, ts.ScriptTarget.Latest, true);
const before = parse(beforeText);
const after = parse(afterText);
const moved = parse(moduleText);
function name(statement) {
  if (statement.name) return statement.name.text;
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    return statement.declarationList.declarations[0].name.getText();
  }
  return null;
}
const withoutImports = (source) => source.statements.filter(s => !ts.isImportDeclaration(s));
const movedStatements = withoutImports(moved);
const movedNames = new Set(movedStatements.map(name));
assert.ok(!movedNames.has(null), 'only named declarations may be moved');
const normalize = (s) => s.getText().replace(/^export /, '');
for (const s of movedStatements) {
  const original = before.statements.filter(b => name(b) === name(s));
  assert.equal(original.length, 1, `original declaration ${name(s)}`);
  assert.equal(normalize(s), normalize(original[0]), `unchanged declaration ${name(s)}`);
}
const remainingBefore = withoutImports(before).filter(s => !movedNames.has(name(s))).map(normalize);
const remainingAfter = withoutImports(after).map(normalize);
assert.deepEqual(remainingAfter, remainingBefore, 'remaining statements and execution order');
// Imported dependencies must resolve to exactly the original modules and names.
const importMap = source => {
  const result = new Map();
  for (const s of source.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause) continue;
    const spec = s.moduleSpecifier.text.replace('../scene-bundle.js', './scene-bundle.js');
    const bindings = s.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) result.set(bindings.name.text, spec + ':*');
    if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) {
      result.set(e.name.text, spec + ':' + (e.propertyName?.text || e.name.text));
    }
  }
  return result;
};
const originalImports = importMap(before);
for (const [binding, dependency] of importMap(moved)) assert.equal(originalImports.get(binding), dependency, `dependency ${binding}`);
const result = { movedDeclarations: movedStatements.length, unchangedRemainingStatements: remainingAfter.length, unchangedFunctions: movedStatements.filter(ts.isFunctionDeclaration).length, originalLines: beforeText.split('\n').length - 1, candidateLines: afterText.split('\n').length - 1 };
console.log(JSON.stringify(result, null, 2));
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
