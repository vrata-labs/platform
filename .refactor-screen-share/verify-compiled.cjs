const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const ts=require(process.env.TYPESCRIPT_PATH || 'typescript');
const [baselineDir,candidateDir,reportFile]=process.argv.slice(2);
const names=['screenShareEntries','hasLocalScreenSharePublishing','remoteScreenShareTrackCount','localScreenShareEntryForSurface','anyLocalScreenShareEntry','screenShareEntryForTrack','screenShareEntryForObject','createScreenShareVideoTexture','clearScreenShareEntryTexture','moveScreenShareEntryToSurface','registerScreenShareEntry','detachScreenShareEntry','unpublishScreenShareEntry','isActiveScreenShareObject','isCurrentScreenShareObject','syncScreenShareRuntimeWithObjects'];
function parse(file){return ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);}
const baseline=parse(path.join(baselineDir,'main.js')),candidate=parse(path.join(candidateDir,'main.js'));
const moduleFile=parse(path.join(candidateDir,'media/screen-share-runtime.js'));
function shape(node,reverseBindings=false){
  if(reverseBindings&&ts.isPropertyAccessExpression(node)&&node.expression.getText()==='context'&&['roomMediaObjects','livekitRoom'].includes(node.name.text))return shape(node.name);
  const children=node.getChildren().filter(n=>n.kind!==ts.SyntaxKind.EndOfFileToken).map(n=>shape(n,reverseBindings));
  return children.length?[node.kind,children]:[node.kind,node.getText()];
}
const factory=moduleFile.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name.text==='createScreenShareRuntime');assert.ok(factory);
for(const name of names){const original=baseline.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name.text===name);const moved=factory.body.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name.text===name);assert.ok(original);assert.ok(moved);assert.deepEqual(shape(moved,true),shape(original),name);}
const baseRemaining=baseline.statements.filter(s=>!(ts.isFunctionDeclaration(s)&&names.includes(s.name.text)));
const candidateRemaining=candidate.statements.filter(s=>!(ts.isImportDeclaration(s)&&s.moduleSpecifier.text==='./media/screen-share-runtime.js')&&!(ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.initializer&&ts.isCallExpression(d.initializer)&&d.initializer.expression.getText()==='createScreenShareRuntime')));
assert.deepEqual(candidateRemaining.map(s=>shape(s)),baseRemaining.map(s=>shape(s)));
function files(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);}
const existing=files(baselineDir).filter(f=>f.endsWith('.js')&&!f.startsWith('assets/'));
for(const f of existing.filter(f=>f!=='main.js'))assert.deepEqual(fs.readFileSync(path.join(candidateDir,f)),fs.readFileSync(path.join(baselineDir,f)),f);
assert.deepEqual(fs.readFileSync(path.join(candidateDir,'main.d.ts')),fs.readFileSync(path.join(baselineDir,'main.d.ts')));
const report={movedFunctions:names.length,remainingCompiledStatements:baseRemaining.length,existingJavaScriptModules:existing.length,identicalJavaScriptModules:existing.length-1,mainDeclarationsIdentical:true};
fs.writeFileSync(reportFile,JSON.stringify(report,null,2));console.log(report);
