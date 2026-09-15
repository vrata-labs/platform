from pathlib import Path
import hashlib, re, json
root=Path.cwd()
p=root/'apps/runtime-web/src/main.ts'
s=p.read_text()
assert hashlib.sha256(s.encode()).hexdigest() == '5fee3989f774cc1819630257b2585234e70c4aa6035335bf4174d940ab941cb2'
start=s.index('function applySurfaceTexture(')
end=s.index('function ensureAudioContext(',start)
block=s[start:end]
wrapper='function applyDisplayTexture(texture: THREE.Texture | null): void {\n  applySurfaceTexture(DEBUG_SURFACE_ID, texture);\n}\n\n'
assert block.count(wrapper)==1
block=block.replace(wrapper,'')
type_start=block.index('type SurfaceTextureSample =')
image_start=block.index('function sampleTextureImage(')
image_end=block.index('function sampleMediaSurfaceTexture(')
types=block[type_start:image_start]
image_fn=block[image_start:image_end]
managed=block[:type_start]+block[image_end:]
state='const debugTextureIds = new WeakMap<THREE.Texture, number>();\nlet nextDebugTextureId = 1;'
assert s.count(state)==1
bindings='''const {
  applySurfaceTexture,
  getSurfaceTextureDebugId,
  sampleMediaSurfaceTexture
} = createMediaSurfaceTextureController({ mediaSurfaceViews, retainedDisplayTextures });'''
new=s[:start]+wrapper+s[end:]
new=new.replace(state,bindings)
imp='import { createMediaSurfaceTextureController } from "./media/media-surface-textures.js";\n'
anchor='import { mediaSurfaceDimensionsChanged, planMediaSurfaceMismatches } from "./media/media-surface-layout.js";\n'
assert new.count(anchor)==1
new=new.replace(anchor,anchor+imp)
header='''import * as THREE from "three";
import type { RuntimeMediaSurfaceView } from "./media-surface-view.js";

'''
factory='''export function createMediaSurfaceTextureController({
  mediaSurfaceViews,
  retainedDisplayTextures
}: {
  mediaSurfaceViews: ReadonlyMap<string, RuntimeMediaSurfaceView>;
  retainedDisplayTextures: ReadonlySet<THREE.Texture>;
}) {
'''
indent=lambda text: '\n'.join('  '+line if line else '' for line in text.rstrip().split('\n'))+'\n'
module=header+'export '+types+'export '+image_fn+factory+indent(state)+'\n'+indent(managed)+'''
  return {
    applySurfaceTexture,
    getSurfaceTextureDebugId,
    findSurfaceWithTexture,
    clearSurfaceTextureWhere,
    sampleMediaSurfaceTexture
  };
}
'''
new_path=root/'apps/runtime-web/src/media/media-surface-textures.ts'
assert not new_path.exists()
p.write_text(new); new_path.write_text(module)
# Reconstruct the baseline byte for byte by undoing only these explicit edits.
restored=new.replace(imp,'').replace(bindings,state).replace(wrapper,s[start:end])
assert restored==s
print(json.dumps({'before':len(s.splitlines()),'after':len(new.splitlines()),'module':len(module.splitlines()),'inverse_reconstruction':True,'baseline_sha256':hashlib.sha256(s.encode()).hexdigest()},indent=2))
