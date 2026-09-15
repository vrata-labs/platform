const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require(path.join(process.cwd(), 'node_modules/typescript'));
const [baselineFile, candidateFile, moduleFile, referenceFile] = process.argv.slice(2);
const parse = f => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const baseline = parse(baselineFile), candidate = parse(candidateFile), moduleSource = parse(moduleFile);
const printer = ts.createPrinter({ removeComments: false });
const text = (n, sf) => printer.printNode(ts.EmitHint.Unspecified, n, sf);
const names = ['applySurfaceTexture','getSurfaceTextureDebugId','findSurfaceWithTexture','clearSurfaceTextureWhere','sampleMediaSurfaceTexture','sampleTextureImage'];
const functions = sf => {
  const result = new Map();
  function visit(n) { if (ts.isFunctionDeclaration(n) && n.name) result.set(n.name.text, n); ts.forEachChild(n, visit); }
  visit(sf); return result;
};
const orig = functions(baseline), moved = functions(moduleSource);
for (const name of names) {
  const a = orig.get(name), b = moved.get(name);
  assert.ok(a && b, `missing ${name}`);
  assert.equal(text(a.body, baseline), text(b.body, moduleSource), `body ${name}`);
  assert.deepEqual(a.parameters.map(n => text(n, baseline)), b.parameters.map(n => text(n, moduleSource)), `parameters ${name}`);
  assert.equal(a.type && text(a.type, baseline), b.type && text(b.type, moduleSource), `return type ${name}`);
}
const factory=functions(moduleSource).get('createMediaSurfaceTextureController');
for (const name of ['debugTextureIds','nextDebugTextureId']) {
  const decl = sf => sf.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name));
  const old = decl(baseline), current = decl(factory.body);
  assert.equal(text(old,baseline),text(current,moduleSource),`state initializer ${name}`);
}
function keep(s) {
  if (ts.isImportDeclaration(s) && s.moduleSpecifier.text === './media/media-surface-textures.js') return false;
  if (ts.isFunctionDeclaration(s) && names.includes(s.name?.text)) return false;
  if (ts.isTypeAliasDeclaration(s) && s.name.text === 'SurfaceTextureSample') return false;
  if (ts.isVariableStatement(s)) {
    if (s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && ['debugTextureIds','nextDebugTextureId'].includes(d.name.text))) return false;
    if (s.declarationList.declarations.some(d => d.initializer && ts.isCallExpression(d.initializer) && d.initializer.expression.getText() === 'createMediaSurfaceTextureController')) return false;
  }
  return true;
}
const unchangedA = baseline.statements.filter(keep).map(n => text(n,baseline));
const unchangedB = candidate.statements.filter(keep).map(n => text(n,candidate));
assert.deepEqual(unchangedB, unchangedA, 'unchanged statements and order');
console.log(JSON.stringify({ format: baselineFile.endsWith('.ts') ? 'TypeScript' : 'JavaScript', unchangedFunctions: names.length, unchangedStateInitializers: 2, unchangedRemainingStatements: unchangedA.length },null,2));
if (referenceFile) {
  // A reference factory built from the ORIGINAL compiled declarations, not the candidate module.
  const state = baseline.statements.filter(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && ['debugTextureIds','nextDebugTextureId'].includes(d.name.text))).map(n => n.getText(baseline)).join('\n');
  const reference = 'import * as THREE from "three";\n' +
    'export ' + orig.get('sampleTextureImage').getText(baseline) + '\n' +
    'export function createMediaSurfaceTextureController({mediaSurfaceViews,retainedDisplayTextures}) {\n' + state + '\n' +
    names.filter(n => n !== 'sampleTextureImage').map(n => orig.get(n).getText(baseline)).join('\n') + '\nreturn { '+names.filter(n => n !== 'sampleTextureImage').join(', ')+' };\n}\n';
  fs.writeFileSync(referenceFile, reference);
}
