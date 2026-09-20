const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const ts=require(process.env.TYPESCRIPT_PATH || path.join(process.argv[2],'node_modules/typescript'));
const root=process.argv[2], dist=process.argv[3], baselineJs=process.argv[4];
const names=['connectMediaSurfaceAudioTrack','disconnectMediaSurfaceAudioTrack','disconnectMediaSurfaceAudioTrackByTrack'];
const stable=['mediaSurfaceViews','mediaSurfaceAudioNodes','getTrackNodeId','ensureAudioContext','createAudioAnalyser','resumeAudioContext','reconcileMediaRoomIdleDisconnect','syncSurfaceAudioControl'];
const text=fs.readFileSync(baselineJs,'utf8');
const sf=ts.createSourceFile(baselineJs,text,ts.ScriptTarget.Latest,true,baselineJs.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
let functions=names.map(n=>{const matches=sf.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name?.text===n);assert.equal(matches.length,1,n);return matches[0].getText(sf)}).join('\n\n');
if (baselineJs.endsWith('.ts')) functions=ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const originalModule=`import vm from "node:vm";\nexport function createMediaSurfaceAudioRuntime(bindings) {\n const scope={get roomMediaObjects(){return bindings.roomMediaObjects},get livekitRoom(){return bindings.livekitRoom}};\n return vm.compileFunction(${JSON.stringify('"use strict"; const {'+stable.join(',')+'}=bindings;\n'+functions+'\nreturn {'+names.join(',')+'};')},["bindings"],{contextExtensions:[scope]})(bindings);\n}\n`;
const modulePath=path.join(dist,'media-surface-audio-runtime.js');
const testsPath=path.join(dist,'media-surface-audio-runtime.test.js');
const candidate=fs.readFileSync(modulePath,'utf8');
function test(label){const run=spawnSync(process.execPath,['--test',testsPath],{encoding:'utf8',timeout:30000});fs.writeFileSync(path.join(root,label+'.log'),run.stdout+run.stderr);assert.equal(run.status,0,label+'\n'+run.stdout+'\n'+run.stderr);return run.stdout.match(/# tests (\d+)/)?.[1];}
const counts={candidate:test('candidate-tests')};
try{fs.writeFileSync(modulePath,originalModule);counts.original=test('original-tests');}finally{fs.writeFileSync(modulePath,candidate);}
counts.restored=test('restored-tests');
assert.equal(counts.original,counts.candidate);assert.equal(counts.restored,counts.candidate);
fs.writeFileSync(path.join(root,'characterization.json'),JSON.stringify(counts,null,2));console.log(counts);
