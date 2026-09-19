import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const evidence = process.env.EVIDENCE;
assert.ok(evidence);
const names = ['createMockShareStream', 'captureAndPublishScreenShareStream'];
const movedImport = './media/screen-share-capture.js';
const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = (source, name) => {
  const found = source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, name);
  return found[0];
};
const remaining = (source) => source.statements
  .filter((node) => !(ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    && !(ts.isImportDeclaration(node) && node.moduleSpecifier.text === movedImport))
  .map((node) => node.getText(source));
const verify = (baselinePath, candidatePath, modulePath) => {
  const baseline = parse(baselinePath);
  const candidate = parse(candidatePath);
  const module = parse(modulePath);
  for (const name of names) {
    const original = declaration(baseline, name);
    const moved = declaration(module, name);
    assert.equal(moved.getText(module).replace(/^export /, ''), original.getText(baseline), name);
    assert.ok(!candidate.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name));
  }
  assert.ok(module.statements.every((node) => ts.isImportDeclaration(node)
    || (ts.isFunctionDeclaration(node) && names.includes(node.name?.text))));
  assert.deepEqual(remaining(candidate), remaining(baseline));
  return { unchangedFunctions: names, unchangedRemainingStatements: remaining(baseline).length };
};
const sourceResult = verify(path.join(evidence, 'main-baseline.ts'),
  'apps/runtime-web/src/main.ts', 'apps/runtime-web/src/media/screen-share-capture.ts');
fs.writeFileSync(path.join(evidence, 'source-equivalence.json'), JSON.stringify(sourceResult, null, 2));
if (process.argv.includes('--source-only')) {
  console.log(JSON.stringify(sourceResult));
  process.exit(0);
}
const dist = path.resolve('apps/runtime-web/dist');
const baselineDist = path.join(evidence, 'baseline-runtime-dist');
const compiledResult = verify(path.join(baselineDist, 'main.js'), path.join(dist, 'main.js'), path.join(dist, 'media/screen-share-capture.js'));
assert.deepEqual(fs.readFileSync(path.join(dist, 'main.d.ts')), fs.readFileSync(path.join(baselineDist, 'main.d.ts')));
const files = fs.readdirSync(baselineDist, { recursive: true }).filter((file) => file.endsWith('.js') && !file.startsWith(`assets${path.sep}`));
for (const file of files.filter((file) => file !== 'main.js')) {
  assert.deepEqual(fs.readFileSync(path.join(dist, file)), fs.readFileSync(path.join(baselineDist, file)), file);
}
const result = { ...compiledResult, identicalExistingJavaScriptModules: files.length - 1, existingJavaScriptModules: files.length, identicalPublicDeclaration: true };
fs.writeFileSync(path.join(evidence, 'compiled-equivalence.json'), JSON.stringify(result, null, 2));
const baseline = parse(path.join(baselineDist, 'main.js'));
const reference = 'import { Track } from "livekit-client";\nimport { createFaultError } from "../runtime-errors.js";\n'
  + names.map((name) => 'export ' + declaration(baseline, name).getText(baseline)).join('\n\n') + '\n';
const originalTest = fs.readFileSync(path.join(dist, 'media/screen-share-capture.test.js'), 'utf8');
assert.equal(originalTest.split('"./screen-share-capture.js"').length, 2);
const baselineTest = originalTest.replace('"./screen-share-capture.js"', '"./screen-share-capture.reference.js"');
const referencePath = path.join(dist, 'media/screen-share-capture.reference.js');
const testPath = path.join(dist, 'media/screen-share-capture.baseline.test.js');
fs.writeFileSync(referencePath, reference);
fs.writeFileSync(testPath, baselineTest);
try {
  const test = spawnSync(process.execPath, ['--test', testPath], { encoding: 'utf8' });
  fs.writeFileSync(path.join(evidence, 'baseline-characterization.log'), test.stdout + test.stderr);
  process.stdout.write(test.stdout);
  process.stderr.write(test.stderr);
  assert.equal(test.status, 0, 'original compiled declarations must pass all characterization tests');
} finally {
  fs.rmSync(referencePath, { force: true });
  fs.rmSync(testPath, { force: true });
}
console.log(JSON.stringify(result));
