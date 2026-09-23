const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2],baseline=process.argv[3];
const ts=require(path.join(root,'node_modules/typescript'));
const src='apps/runtime-web/src/';
const original=fs.readFileSync(path.join(baseline,src,'main.ts'),'utf8');
const main=fs.readFileSync(path.join(root,src,'main.ts'),'utf8');
const mod=fs.readFileSync(path.join(root,src,'notes-runtime.ts'),'utf8');
const parse=s=>ts.createSourceFile('x.ts',s,ts.ScriptTarget.Latest,true);
const funcs=['canViewNotes','canEditNotes','setNotesSaveState','renderNotesPreview','renderNotesHistoryUi','syncNotesAccessUi','notesErrorCode','loadActiveNote','loadActiveNoteVersions','scheduleNotesAutosave','saveActiveNote','restoreSelectedNoteVersion','exportActiveNote','exportRoomNotesJson'];
const vars=['activeNotesScope','notesSaveState','notesLastSavedContent','notesLastUpdatedAt','notesLoadSeq','notesSaveSeq','notesAutosaveTimer','notesVersions','notesHistoryLoading','notesExportInFlight'];
const old=parse(original),cur=parse(main),moduleAst=parse(mod);
const getfn=(file,name)=>file.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name.text===name);
const factory=getfn(moduleAst,'createNotesRuntime');
function undo(s,object,names) {
 const f=parse(s),repls=[];
 function walk(n) {if(ts.isPropertyAccessExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text===object&&names.includes(n.name.text))repls.push([n.getStart(f),n.end,n.name.text]);ts.forEachChild(n,walk);}
 walk(f);for(const [a,b,text]of repls.sort((x,y)=>y[0]-x[0]))s=s.slice(0,a)+text+s.slice(b);return s;
}
for(const name of funcs){
 const node=factory.body.statements.find(st=>ts.isFunctionDeclaration(st)&&st.name.text===name);
 let actual=node.getText(moduleAst).split('\n').map((l,i)=>i>0&&l.startsWith('  ')?l.slice(2):l).join('\n');
 actual=undo(undo(actual,'state',vars),'context',['runtimeFlags','roomStateAccessToken']);
 assert.equal(actual,getfn(old,name).getText(old),name);
}
let restored=main;
const init=cur.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations[0].name.getText(cur)==='notesState');
const originals=old.statements.filter(s=>ts.isVariableStatement(s)&&vars.includes(s.declarationList.declarations[0].name.getText(old)));
const instance=cur.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations[0].initializer?.expression?.text==='createNotesRuntime');
restored=restored.replace(instance.getText(cur),funcs.slice(0,3).map(n=>getfn(old,n).getText(old)).join('\n\n'));
restored=restored.replace(init.getText(cur),originals.map(n=>n.getText(old)).join('\n'));
restored=undo(restored,'notesState',vars);
restored=restored.replace('activeNotesScope: activeNotesScope,','activeNotesScope,').replace('notesSaveState: notesSaveState,','notesSaveState,');
restored=restored.replace('function canViewDocuments()',funcs.slice(3).map(n=>getfn(old,n).getText(old)).join('\n\n')+'\n\nfunction canViewDocuments()');
for(const spec of ['./notes.js','./index.js']){
 const before=old.statements.find(s=>ts.isImportDeclaration(s)&&s.moduleSpecifier.text===spec).getText(old);
 const f=parse(restored),after=f.statements.find(s=>ts.isImportDeclaration(s)&&s.moduleSpecifier.text===(spec==='./notes.js'?'./notes-runtime.js':spec)).getText(f);
 restored=restored.replace(after,before);
}
assert.equal(restored,original,'Inverse source reconstruction');
const stateFactory=getfn(moduleAst,'createNotesRuntimeState');
const properties=stateFactory.body.statements[0].expression.properties;
assert.deepEqual(properties.map(n=>n.name.text),vars);
for(const prop of properties.slice(1)){
 const originalDeclaration=originals.find(st=>st.declarationList.declarations[0].name.getText(old)===prop.name.text).declarationList.declarations[0];
 assert.equal(prop.initializer.getText(moduleAst),originalDeclaration.initializer.getText(old));
}
const statementCount=old.statements.length-funcs.length-originals.length;
console.log(`Verified exact inverse source, 14 function bodies/signatures, 10 state initializers and ${statementCount} other top-level statements (two imports adapted).`);
const early=cur.statements.filter(s=>s.end<instance.getStart(cur)&&!ts.isFunctionDeclaration(s)&&!ts.isImportDeclaration(s)&&!ts.isTypeAliasDeclaration(s));
for(const s of early){for(const name of funcs){assert.ok(!new RegExp('\\b'+name+'\\b').test(s.getText(cur)),`Early binding ${name}`);}}
console.log('No early non-function references to extracted notes operations.');
