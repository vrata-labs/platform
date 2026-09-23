const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.argv[2]; const ts=require(path.join(root,'node_modules/typescript'));
const main=fs.readFileSync(path.join(root,'../original-main.js'),'utf8');
const ast=ts.createSourceFile('main.js',main,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const funcs=['canViewNotes','canEditNotes','setNotesSaveState','renderNotesPreview','renderNotesHistoryUi','syncNotesAccessUi','notesErrorCode','loadActiveNote','loadActiveNoteVersions','scheduleNotesAutosave','saveActiveNote','restoreSelectedNoteVersion','exportActiveNote','exportRoomNotesJson'];
const exposed=['canViewNotes','syncNotesAccessUi','loadActiveNote','scheduleNotesAutosave','saveActiveNote','restoreSelectedNoteVersion','exportActiveNote','exportRoomNotesJson'];
const original=funcs.map(name=>ast.statements.find(st=>ts.isFunctionDeclaration(st)&&st.name.text===name).getText(ast)).join('\n\n');
const dirname=path.join(root,'apps/runtime-web/dist');const target=path.join(dirname,'notes-runtime.js');const candidate=fs.readFileSync(target,'utf8');
const source='"use strict";\nconst {apiBaseUrl,roomId,debugState,downloadBlob}=context;\nconst {fetchRoomNote,listRoomNoteVersions,saveRoomNote,restoreRoomNoteVersion,exportRoomNote,exportRoomNotesArchive}=context.api;\nconst {notesPanelEl,notesScopeSelect,notesEditor,notesRetrySaveButton,notesStatusEl,notesPreviewEl,notesVersionSelect,notesRestoreVersionButton,notesExportMarkdownButton,notesExportJsonButton,notesExportRoomJsonButton}=context.elements;\n'+original+'\nglobalThis.result={'+exposed.join(',')+'};';
const code=`import vm from 'node:vm';\nimport { hasRoomPermission } from '@vrata/shared-types';\nimport { nextNotesSaveState, parseSafeMarkdown } from './notes.js';\nexport { createNotesRuntimeState } from './notes-runtime-candidate.js';\nexport function createNotesRuntime(context) {\nconst scope = {context,hasRoomPermission,nextNotesSaveState,parseSafeMarkdown,Error,Date,String,console};\nfor (const name of Object.keys(context.state)) Object.defineProperty(scope,name,{get(){return context.state[name]},set(value){context.state[name]=value}});\nfor (const name of ['runtimeFlags','roomStateAccessToken']) Object.defineProperty(scope,name,{get(){return context[name]}});\nfor (const name of ['document','Option','window']) Object.defineProperty(scope,name,{get(){return globalThis[name]}});\nvm.runInNewContext(${JSON.stringify(source)},scope);\nreturn scope.result;\n}\n`;
fs.writeFileSync(path.join(dirname,'notes-runtime-candidate.js'),candidate);
try {
 fs.writeFileSync(target,code);
 const run=cp.spawnSync(process.execPath,['--test','apps/runtime-web/dist/notes-runtime.test.js','apps/runtime-web/dist/notes-runtime-async.test.js'],{cwd:root,encoding:'utf8'});
 fs.writeFileSync(path.join(root,'../notes-original-tests.log'),run.stdout+run.stderr);
 console.log(run.stdout.split('\n').slice(-12).join('\n'));if(run.status!==0)throw new Error('Original tests failed');
} finally {fs.writeFileSync(target,candidate);fs.unlinkSync(path.join(dirname,'notes-runtime-candidate.js'));}
