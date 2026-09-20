const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = process.argv[2];
const ts = require(process.env.TYPESCRIPT_PATH || path.join(root, 'node_modules/typescript'));
const mainPath = path.join(root, 'apps/runtime-web/src/main.ts');
const source = fs.readFileSync(mainPath, 'utf8');
const blob = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
assert.equal(blob, '0c336642b9968dffae6ed097ea7f7963a84d7c11', 'Unexpected main.ts baseline');
const names = ['connectMediaSurfaceAudioTrack', 'disconnectMediaSurfaceAudioTrack', 'disconnectMediaSurfaceAudioTrackByTrack'];
const sf = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const declarations = [...names, 'MediaSurfaceAudioNode'].map(name => {
  const found = sf.statements.filter(node => node.name?.text === name);
  assert.equal(found.length, 1, name);
  return found[0];
});
const functions = declarations.slice(0, 3).map(node => node.getText(sf));
const type = declarations[3].getText(sf);
const stable = ['mediaSurfaceViews', 'mediaSurfaceAudioNodes', 'getTrackNodeId', 'ensureAudioContext', 'createAudioAnalyser', 'resumeAudioContext', 'reconcileMediaRoomIdleDisconnect', 'syncSurfaceAudioControl'];
const body = functions.join('\n\n').replace(/\broomMediaObjects\b/g, 'bindings.roomMediaObjects').replace(/\blivekitRoom\b/g, 'bindings.livekitRoom');
const moduleSource = `import type { Room, Track } from "livekit-client";
import type { RoomMediaObjectsState } from "@vrata/shared-types";

export ${type}

interface MediaSurfaceAudioRuntimeContext {
  readonly roomMediaObjects: RoomMediaObjectsState | null;
  readonly livekitRoom: Room | null;
  mediaSurfaceViews: ReadonlyMap<string, unknown>;
  mediaSurfaceAudioNodes: Map<string, MediaSurfaceAudioNode>;
  getTrackNodeId: (track: Track, fallback: string) => string;
  ensureAudioContext: () => AudioContext;
  createAudioAnalyser: (context: AudioContext) => { analyser: AnalyserNode; sampleBuffer: Uint8Array };
  resumeAudioContext: () => Promise<void>;
  reconcileMediaRoomIdleDisconnect: (room: Room | null, diagnosticsReason: string) => void;
  syncSurfaceAudioControl: () => void;
}

export function createMediaSurfaceAudioRuntime(bindings: MediaSurfaceAudioRuntimeContext) {
  const {
${stable.map(name => `    ${name}`).join(',\n')}
  } = bindings;

${body.split('\n').map(line => line ? `  ${line}` : '').join('\n')}

  return {
${names.map(name => `    ${name}`).join(',\n')}
  };
}
`;
let result = source;
for (const decl of [...declarations].sort((a,b) => b.getStart(sf) - a.getStart(sf))) {
  const start = decl.getStart(sf), end = decl.end + 2;
  assert.equal(source.slice(decl.end, end), '\n\n');
  result = result.slice(0, start) + result.slice(end);
}
const oldImport = 'import { createScreenShareRuntime, type ScreenShareRuntimeEntry } from "./media/screen-share-runtime.js";';
const newImport = 'import { createMediaSurfaceAudioRuntime, type MediaSurfaceAudioNode } from "./media/media-surface-audio-runtime.js";';
assert.equal(result.split(oldImport).length, 2);
result = result.replace(oldImport, `${oldImport}\n${newImport}`);
const anchor = 'const mediaSurfaceAudioNodes = new Map<string, MediaSurfaceAudioNode>();';
const wiring = `const {
${names.map(name => `  ${name}`).join(',\n')}
} = createMediaSurfaceAudioRuntime({
${stable.map(name => `  ${name},`).join('\n')}
  get roomMediaObjects() { return roomMediaObjects; },
  get livekitRoom() { return livekitRoom; }
});`;
assert.equal(result.split(anchor).length,2);
result = result.replace(anchor, `${anchor}\n${wiring}`);
// Verify the extraction mechanically before writing any files.
const inverseBody = body.replace(/bindings\.roomMediaObjects/g, 'roomMediaObjects').replace(/bindings\.livekitRoom/g, 'livekitRoom');
assert.equal(inverseBody, functions.join('\n\n'));
let inverse = result.replace(`${oldImport}\n${newImport}`, oldImport).replace(`${anchor}\n${wiring}`, anchor);
for (const decl of [...declarations].sort((a,b)=>a.getStart(sf)-b.getStart(sf))) {
  const start = decl.getStart(sf);
  inverse = inverse.slice(0, start) + source.slice(start, decl.end + 2) + inverse.slice(start);
}
assert.equal(inverse, source, 'Exact inverse reconstruction');
const outDir=path.join(root, 'apps/runtime-web/src/media');
const modulePath=path.join(outDir,'media-surface-audio-runtime.ts');
assert.ok(!fs.existsSync(modulePath));
fs.writeFileSync(mainPath, result);fs.writeFileSync(modulePath,moduleSource);
const metadata={ baselineBlob:blob, functions:names, stable, originalFunctions:functions, originalType:type, import:newImport, wiring,
  beforeLines:source.split('\n').length-1, afterLines:result.split('\n').length-1, moduleLines:moduleSource.split('\n').length-1 };
fs.writeFileSync(path.join(root, 'extraction.json'),JSON.stringify(metadata,null,2));
console.log(JSON.stringify({beforeLines:metadata.beforeLines, afterLines:metadata.afterLines, moduleLines:metadata.moduleLines, sourceInverse:true}));
