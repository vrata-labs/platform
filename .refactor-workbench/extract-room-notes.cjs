const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require(process.cwd() + '/node_modules/typescript');
const path = 'apps/api/src/index.ts';
const source = fs.readFileSync(path, 'utf8');
const blob = s => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
assert.equal(blob(source), '5302e26d6af29f91b0f9928ac1dcef26eb3610c4', 'Unexpected API baseline');
const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const functions = new Map(sf.statements.filter(ts.isFunctionDeclaration).map(n => [n.name.text, n]));
const helperNames = ['roomNoteId', 'emptyRoomNote', 'writeRoomNotesAudit', 'noteActorPermissions', 'noteWritePermission', 'resolveRoomNoteOwner', 'resolveRoomNotesActor', 'resolveAuthorizedRoomNoteOwner', 'roomNoteVisibleToActor'];
const helpers = helperNames.map(n => { assert(functions.has(n), n); return functions.get(n); });
const actor = sf.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === 'ControlPlaneActor');
assert(actor);
const indent = (text, spaces) => text.split('\n').map(line => line ? ' '.repeat(spaces) + line : line).join('\n');
const accessHeader = `import type { IncomingMessage, ServerResponse } from "node:http";
import { getRoomPermissions, hasRoomPermission, type RoomPermission } from "@vrata/shared-types";
import type { ControlPlaneActor } from "./control-plane-actor.js";
import type { createApiMetrics } from "./api-metrics.js";
import { incrementCounter } from "./api-metrics.js";
import { json } from "./http-responses.js";
import { isRoomDisabled } from "./room-session-control.js";
import type { RoomNoteRecord, RoomNoteScope, RoomRecord } from "./storage.js";

export interface RoomNotesAccessContext {
  metrics: Pick<ReturnType<typeof createApiMetrics>["metrics"],
    "notesCreatedTotal" | "notesSavedTotal" | "notesSaveFailuresTotal" | "notesPermissionDeniedTotal" |
    "notesVersionsCreatedTotal" | "notesRestoresTotal" | "notesExportsTotal" | "notesExportDeniedTotal"
  >;
  resolveControlPlaneActor(request: IncomingMessage):
    | { ok: true; actor: ControlPlaneActor }
    | { ok: false; statusCode: 401; reason: string };
  getRequestId(request: IncomingMessage): string;
  logEvent(event: Record<string, unknown>): void;
}

export function createRoomNotesAccess(context: RoomNotesAccessContext) {
  const { metrics, resolveControlPlaneActor, getRequestId, logEvent } = context;

`;
const access = accessHeader + helpers.map(n => indent(n.getText(sf), 2)).join('\n\n') + `

  return {
    emptyRoomNote, writeRoomNotesAudit, noteWritePermission, resolveRoomNotesActor,
    resolveAuthorizedRoomNoteOwner, roomNoteVisibleToActor
  };
}
`;
const routeNames = ['roomNotesArchiveExportMatch', 'roomNoteVersionsMatch', 'roomNoteRestoreMatch', 'roomNoteExportMatch', 'roomNotesMatch'];
const statements = functions.get('handleRequest').body.statements;
const groups = routeNames.map(name => {
  const i = statements.findIndex(n => ts.isVariableStatement(n) && n.declarationList.declarations[0].name.getText(sf) === name);
  assert(i >= 0, name);
  const matcher = statements[i], branch = statements[i+1];
  assert(ts.isIfStatement(branch) && !branch.elseStatement && ts.isBlock(branch.thenStatement));
  return { matcher, branch };
});
const first = groups[0].matcher, last = groups.at(-1).branch;
assert.equal(statements.indexOf(last) - statements.indexOf(first), 9);
const routesHeader = `import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoomNoteScope, Storage } from "./storage.js";
import { isNotesFeatureEnabled } from "./feature-flags.js";
import { incrementCounter } from "./api-metrics.js";
import { parseBody } from "./request-body.js";
import { attachment, json } from "./http-responses.js";
import { createStoredZip } from "./stored-zip.js";
import { noteExportFilename, noteExportJson, formatNoteMarkdown, formatRoomNotesMarkdown } from "./notes-export.js";
import { createRoomNotesAccess, type RoomNotesAccessContext } from "./room-notes-access.js";

export function createRoomNotesRoutes(context: RoomNotesAccessContext) {
  const { metrics } = context;
  const {
    emptyRoomNote, writeRoomNotesAudit, noteWritePermission, resolveRoomNotesActor,
    resolveAuthorizedRoomNoteOwner, roomNoteVisibleToActor
  } = createRoomNotesAccess(context);

  // An unmatched request falls through synchronously; only a matched route starts work.
  return function routeRoomNotesRequest(
    request: IncomingMessage, response: ServerResponse, method: string, url: URL, storage: Storage
  ): Promise<void> | null {
`;
const routeBody = groups.map(({matcher,branch}) => {
  const body = source.slice(branch.thenStatement.getStart(sf) + 1, branch.thenStatement.end - 1).replace(/^\n/, '').replace(/\n  $/, '');
  return indent(matcher.getText(sf),4) + '\n' + `    if (${branch.expression.getText(sf)}) {\n      return (async () => {\n` + indent(body,4) + `\n      })();\n    }`;
}).join('\n\n');
const routes = routesHeader + routeBody + '\n\n    return null;\n  };\n}\n';
const actorSource = `import type { RoomPermission, RoomRole } from "@vrata/shared-types";
import type { RoomSessionRoleSource } from "@vrata/shared-types/session-token";

export ` + actor.getText(sf) + '\n';
const edits = [
  { start: actor.getStart(sf), end: actor.end+2, text: '' },
  { start: helpers[0].getStart(sf), end: helpers.at(-1).end+2, text: '' },
  { start: first.getStart(sf), end: last.end, text: `const roomNotesResponse = routeRoomNotesRequest(request, response, method, url, storage);\n  if (roomNotesResponse) return roomNotesResponse;` }
];
let next = source;
for (const edit of edits.sort((a,b) => b.start-a.start)) next = next.slice(0,edit.start) + edit.text + next.slice(edit.end);
for (const text of ['  type RoomNoteRecord,\n','  type RoomNoteScope,\n','import { createStoredZip } from "./stored-zip.js";\n\n','import { noteExportFilename, noteExportJson, formatNoteMarkdown, formatRoomNotesMarkdown } from "./notes-export.js";\n\n']) {
  assert.equal(next.split(text).length,2, text);
  next = next.replace(text,'');
}
next = next.replace('import { serveStatic, json, text, attachment } from "./http-responses.js";', 'import { serveStatic, json, text } from "./http-responses.js";');
const anchor = 'const { metrics, apiMetricsText } = createApiMetrics(presenceByRoom, cleanupAllPresence, activeParticipantCount);';
assert.equal(next.split(anchor).length,2);
next = next.replace(anchor, anchor + '\nconst routeRoomNotesRequest = createRoomNotesRoutes({ metrics, resolveControlPlaneActor, getRequestId, logEvent });');
next = 'import type { ControlPlaneActor } from "./control-plane-actor.js";\nimport { createRoomNotesRoutes } from "./room-notes-routes.js";\n' + next;
const outputs = { [path]: next, 'apps/api/src/control-plane-actor.ts': actorSource, 'apps/api/src/room-notes-access.ts': access, 'apps/api/src/room-notes-routes.ts': routes };
for (const [name, content] of Object.entries(outputs)) {
  if (name !== path) assert(!fs.existsSync(name),name);
  fs.writeFileSync(name,content);
}
// Compare actual token trees, excluding whitespace/comments only. No business-code normalization.
function tokens(text) {
  const parsed = ts.createSourceFile('check.ts', text, ts.ScriptTarget.Latest, true);
  const out = [];
  function visit(node) {
    const children = node.getChildren(parsed);
    if (children.length) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken) out.push([node.kind,node.getText(parsed)]);
  }
  visit(parsed);
  return out;
}
const accessSf=ts.createSourceFile('access.ts',access,ts.ScriptTarget.Latest,true);
const moved=accessSf.statements.find(ts.isFunctionDeclaration).body.statements.filter(ts.isFunctionDeclaration);
assert.equal(moved.length,helpers.length);
helpers.forEach((n,i)=>assert.deepEqual(tokens(n.getText(sf)),tokens(moved[i].getText(accessSf))));
const routesSf=ts.createSourceFile('routes.ts',routes,ts.ScriptTarget.Latest,true);
const routeRoot=routesSf.statements.find(ts.isFunctionDeclaration).body.statements.find(ts.isReturnStatement).expression;
const actualGroups=routeRoot.body.statements.filter(ts.isIfStatement);
const actualMatchers=routeRoot.body.statements.filter(ts.isVariableStatement);
groups.forEach(({matcher},i)=>assert.deepEqual(tokens(matcher.getText(sf)),tokens(actualMatchers[i].getText(routesSf))));
groups.forEach(({branch},i)=> {
 const call=actualGroups[i].thenStatement.statements[0].expression;
 const body=call.expression.expression.body;
 assert.deepEqual(tokens(branch.thenStatement.getText(sf)),tokens(body.getText(routesSf)));
 assert.deepEqual(tokens(branch.expression.getText(sf)),tokens(actualGroups[i].expression.getText(routesSf)));
});
const nextSf=ts.createSourceFile(path,next,ts.ScriptTarget.Latest,true);
let unchanged=0;
for (const n of sf.statements.filter(ts.isFunctionDeclaration)) {
 if (helperNames.includes(n.name.text) || n.name.text==='handleRequest') continue;
 const same=nextSf.statements.find(m=>ts.isFunctionDeclaration(m)&&m.name.text===n.name.text);
 assert(same,n.name.text);assert.deepEqual(tokens(n.getText(sf)),tokens(same.getText(nextSf)));unchanged++;
}
const nextHandler=nextSf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='handleRequest');
const originalOther=statements.filter(n => n.end <= first.getStart(sf) || n.getStart(sf)>=last.end);
const newOther=nextHandler.body.statements.filter(n=>!n.getText(nextSf).startsWith('const roomNotesResponse')&&!n.getText(nextSf).startsWith('if (roomNotesResponse)'));
assert.deepEqual(originalOther.map(n=>tokens(n.getText(sf))),newOther.map(n=>tokens(n.getText(nextSf))));
console.log(JSON.stringify({before:blob(source),files:Object.fromEntries(Object.entries(outputs).map(([p,s])=>[p,{sha:blob(s),lines:s.split('\n').length-1,bytes:Buffer.byteLength(s)}])),preservedHelpers:moved.length,preservedRouteBodies:groups.length,unchangedFunctions:unchanged,unchangedRequestStatements:originalOther.length},null,2));
