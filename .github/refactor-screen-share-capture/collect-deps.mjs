import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const evidence = process.env.EVIDENCE;
assert.ok(evidence);
const store = path.join(root, 'node_modules/.pnpm');
const output = path.join(evidence, 'verification-deps/node_modules');
fs.mkdirSync(path.join(output, '.pnpm'), { recursive: true });
const packages = new Map();
const containers = new Set();
function locate(from, name) {
  const require = createRequire(path.join(from, 'package.json'));
  const found = require.resolve.paths(name)?.map((entry) => path.join(entry, name))
    .find((entry) => fs.existsSync(path.join(entry, 'package.json')));
  if (!found) throw new Error(`dependency_not_found:${name}:${from}`);
  return fs.realpathSync(found);
}
function collect(directory) {
  if (packages.has(directory)) return;
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  packages.set(directory, { name: manifest.name, version: manifest.version });
  const relative = path.relative(store, directory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const container = relative.split(path.sep)[0];
  if (!containers.has(container)) {
    fs.cpSync(path.join(store, container), path.join(output, '.pnpm', container), {
      recursive: true, dereference: false, verbatimSymlinks: true
    });
    containers.add(container);
  }
  const required = manifest.dependencies ?? {};
  const optional = { ...manifest.peerDependencies, ...manifest.optionalDependencies };
  for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {
    let dependency;
    try { dependency = locate(directory, name); }
    catch (error) { if (name in required && !(name in (manifest.optionalDependencies ?? {}))) throw error; else continue; }
    collect(dependency);
  }
}
for (const [from, name] of [
  [path.join(root, 'apps/runtime-web'), 'livekit-client'],
  [root, 'typescript'], [root, '@types/node']
]) {
  const directory = locate(from, name);
  collect(directory);
  const link = path.join(output, name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const target = path.join(output, '.pnpm', path.relative(store, directory));
  fs.symlinkSync(path.relative(path.dirname(link), target), link);
}
fs.writeFileSync(path.join(evidence, 'verification-dependencies.json'), JSON.stringify([...packages.values()], null, 2));
console.log(`Collected ${packages.size} locked packages for isolated verification`);
