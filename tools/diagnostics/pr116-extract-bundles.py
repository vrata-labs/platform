import hashlib,io,json,pathlib,tarfile,zipfile
p=pathlib.Path('diagnostic-preparation.zip')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='9b6de24603de2c4f60b522a18e6970f565a8ab9e4857145e79702382b6a3f6b3'
z=zipfile.ZipFile(p);assert z.testzip() is None
root=pathlib.Path('diagnostic-bundles');root.mkdir()
variants=[('baseline','baseline-runtime-dist.tar.gz','main-DX4Wj_52.js','6685a20d20277c5930b8e1c7e106ab6bb7f77454e559c64d265f85f5581e2615'),('candidate','runtime-dist.tar.gz','main-qQINGoqI.js','596f0a89cf0b4dbc3b9676fed6f99798f7e27cf12f8797890fc1c5027d90a5db')]
assets=[]
for variant,archive,entry,digest in variants:
    t=tarfile.open(fileobj=io.BytesIO(z.read(archive)),mode='r:gz')
    data=t.extractfile('apps/runtime-web/dist/assets/'+entry).read()
    assert hashlib.sha256(data).hexdigest()==digest
    (root/(variant+'.js')).write_bytes(data)
    assets.append({m.name:t.extractfile(m).read() for m in t.getmembers() if m.isfile() and m.name.startswith('apps/runtime-web/dist/assets/') and not pathlib.PurePosixPath(m.name).name.startswith('main-')})
assert assets[0]==assets[1], 'non_entry_assets_differ'
print(json.dumps({'preparedArtifact':10794965824,'nonEntryAssetsIdentical':len(assets[0]),'variants':[{'variant':v,'filename':n,'sha256':h} for v,_,n,h in variants]}))
