const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const root = process.argv[2];
const mainPath = path.join(root, 'apps/runtime-web/src/main.ts');
const source = fs.readFileSync(mainPath, 'utf8');
const parsed = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, true);
const names = ['screenShareEntries','hasLocalScreenSharePublishing','remoteScreenShareTrackCount',
  'localScreenShareEntryForSurface','anyLocalScreenShareEntry','screenShareEntryForTrack','screenShareEntryForObject',
  'createScreenShareVideoTexture','clearScreenShareEntryTexture','moveScreenShareEntryToSurface','registerScreenShareEntry',
  'detachScreenShareEntry','unpublishScreenShareEntry','isActiveScreenShareObject','isCurrentScreenShareObject','syncScreenShareRuntimeWithObjects'];
const exposed = names.filter(n => !['clearScreenShareEntryTexture','isCurrentScreenShareObject'].includes(n));
const declarations = names.map(name => {
  const matches = parsed.statements.filter(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.equal(matches.length, 1, name); return matches[0];
});
const entryType = parsed.statements.find(s => ts.isTypeAliasDeclaration(s) && s.name.text === 'ScreenShareRuntimeEntry');
assert.ok(entryType);
const bindings = ['roomMediaObjects','livekitRoom'];
function transform(node) {
  const edits = [];
  function visit(child) {
    if (ts.isIdentifier(child) && bindings.includes(child.text)) edits.push({start:child.getStart()-node.getStart(),end:child.end-node.getStart(),replacement:`context.${child.text}`});
    ts.forEachChild(child, visit);
  }
  visit(node);
  let text = node.getText(parsed);
  for (const edit of edits.sort((a,b)=>b.start-a.start)) text = text.slice(0,edit.start)+edit.replacement+text.slice(edit.end);
  return text.split('\n').map(line=>line ? '  '+line : line).join('\n');
}
const header = `import * as THREE from "three";
import type { Room, Track } from "livekit-client";
import { SCREEN_SHARE_OBJECT_TYPE, type MediaObjectInstance, type RoomMediaObjectsState, type ScreenShareObjectState } from "@vrata/shared-types";

import { physicalScreenShareObjectForMediaTrack } from "./media-object-state.js";
import type { RuntimeMediaSurfaceView } from "./media-surface-view.js";

export ${entryType.getText(parsed)}

export interface ScreenShareRuntimeContext {
  screenShareRuntimeByObjectId: Map<string, ScreenShareRuntimeEntry>;
  retainedDisplayTextures: Set<THREE.Texture>;
  mediaSurfaceViews: Pick<ReadonlyMap<string, RuntimeMediaSurfaceView>, "has">;
  debugState: { screenShareState: string; screenShare: { remoteSubscribedTrackCount: number } };
  // Read replaceable room/session state when an operation runs, not at construction.
  readonly roomMediaObjects: RoomMediaObjectsState | null;
  readonly livekitRoom: Room | null;
  getMediaSurfaceView: (surfaceId: string) => RuntimeMediaSurfaceView;
  applySurfaceTexture: (surfaceId: string, texture: THREE.Texture | null) => void;
  reconcileMediaRoomIdleDisconnect: (room: Room | null, diagnosticsReason: string) => void;
}

export function createScreenShareRuntime(context: ScreenShareRuntimeContext) {
  const {
    screenShareRuntimeByObjectId,
    retainedDisplayTextures,
    mediaSurfaceViews,
    debugState,
    getMediaSurfaceView,
    applySurfaceTexture,
    reconcileMediaRoomIdleDisconnect
  } = context;

`;
const moduleText = header + declarations.map(transform).join('\n\n') + '\n\n  return {\n' + exposed.map(n=>'    '+n).join(',\n') + '\n  };\n}\n';
const importText = 'import { createScreenShareRuntime, type ScreenShareRuntimeEntry } from "./media/screen-share-runtime.js";\n';
const wiring = `\nconst {\n${exposed.map(n=>'  '+n).join(',\n')}\n} = createScreenShareRuntime({
  screenShareRuntimeByObjectId,
  retainedDisplayTextures,
  mediaSurfaceViews,
  debugState,
  getMediaSurfaceView,
  applySurfaceTexture,
  reconcileMediaRoomIdleDisconnect,
  get roomMediaObjects() { return roomMediaObjects; },
  get livekitRoom() { return livekitRoom; }
});\n`;
const lastImport = parsed.statements.filter(ts.isImportDeclaration).at(-1);
const debug = parsed.statements.find(s=>ts.isVariableStatement(s) && s.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==='debugState'));
assert.ok(lastImport); assert.ok(debug);
const earlyReferences=[];
function visitEarly(node) {
  if (ts.isFunctionLike(node) || declarations.includes(node) || node===entryType) return;
  if (ts.isIdentifier(node) && names.includes(node.text)) earlyReferences.push(node.text);
  ts.forEachChild(node, visitEarly);
}
for (const statement of parsed.statements) if(statement.end<=debug.end) visitEarly(statement);
assert.deepEqual(earlyReferences,[]);
const edits = [...declarations,entryType].map(n=>({start:n.getStart(),end:n.end+2,old:source.slice(n.getStart(),n.end+2),replacement:''}));
assert.ok(edits.every(e=>e.old.endsWith('\n\n')));
edits.push({start:lastImport.end+1,end:lastImport.end+1,old:'',replacement:importText});
edits.push({start:debug.end+1,end:debug.end+1,old:'',replacement:wiring});
let candidate=source;
for (const e of edits.sort((a,b)=>b.start-a.start)) candidate=candidate.slice(0,e.start)+e.replacement+candidate.slice(e.end);
let offset=0;
for (const e of [...edits].sort((a,b)=>a.start-b.start)) {e.candidateStart=e.start+offset;offset+=e.replacement.length-(e.end-e.start);}
let inverse=candidate;
for (const e of [...edits].sort((a,b)=>b.candidateStart-a.candidateStart)) inverse=inverse.slice(0,e.candidateStart)+e.old+inverse.slice(e.candidateStart+e.replacement.length);
assert.equal(inverse,source);
fs.writeFileSync(mainPath,candidate);
fs.writeFileSync(path.join(root,'apps/runtime-web/src/media/screen-share-runtime.ts'),moduleText);
const report={names,exposed,baseLines:source.split('\n').length-1,candidateLines:candidate.split('\n').length-1,moduleLines:moduleText.split('\n').length-1,earlyReferences,remainingStatements:parsed.statements.length-declarations.length-1,edits};
fs.writeFileSync(path.join(root,'../extraction.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(root,'../main-baseline.ts'),source);
console.log(JSON.stringify({...report,edits:undefined},null,2));
