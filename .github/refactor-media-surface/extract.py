from pathlib import Path
import hashlib

root = Path.cwd()
main_path = root / 'apps/runtime-web/src/main.ts'
original = main_path.read_text()
assert hashlib.sha1(b'blob ' + str(len(original.encode())).encode() + b'\0' + original.encode()).hexdigest() == '848cae28179bcdb9846f4b02e6a3b9ac6dda0599', 'baseline main.ts differs'

# Move declarations verbatim. Rendering/setup statements stay at their original locations.
ranges = [
    ('const WHITEBOARD_PENCIL_CONTACT_DISTANCE_M =', 'const WHITEBOARD_PENCIL_GRIP_ROTATION ='),
    ('const DEBUG_SURFACE_ID =', 'const displaySurface ='),
    ('interface RuntimeMediaSurfaceView {', 'const mediaSurfaceViews ='),
    ('function runtimeMediaSurfaceDefinitionFromScene(', 'function getFallbackMediaSurfaceView('),
]
blocks = []
main = original
for start_marker, end_marker in ranges:
    assert main.count(start_marker) == 1 and main.count(end_marker) == 1
    start = main.index(start_marker)
    end = main.index(end_marker, start)
    block = main[start:end]
    blocks.append(block.rstrip())
    main = main[:start] + main[end:]

exports = [
    'const DEBUG_SURFACE_ID', 'const DEBUG_SURFACE_WIDTH_M',
    'const DEBUG_SURFACE_HEIGHT_M', 'const DEBUG_SURFACE_HEIGHT_PX',
    'interface RuntimeMediaSurfaceDefinition', 'const DEFAULT_RUNTIME_MEDIA_SURFACES',
    'function createMediaSurfaceMesh', 'function applyMediaSurfaceTransform',
    'interface RuntimeMediaSurfaceView', 'function updateMediaSurfaceView',
    'function createMediaSurfaceView', 'function runtimeMediaSurfaceDefinitionFromScene',
]
module = '\n\n'.join(blocks) + '\n'
for declaration in exports:
    assert module.count(declaration) == 1
    module = module.replace(declaration, 'export ' + declaration, 1)
module_imports = '''import * as THREE from "three";
import { DEFAULT_MEDIA_SURFACE_ID, LAPTOP_MEDIA_SURFACE_ID, WHITEBOARD_MEDIA_SURFACE_ID } from "@vrata/shared-types";
import { LEGACY_MEDIA_SURFACE_NEAR_CONTACT_DISTANCE_M, type SceneBundleMediaSurface } from "../scene-bundle.js";

'''
main_import = '''import {
  DEBUG_SURFACE_ID,
  DEBUG_SURFACE_WIDTH_M,
  DEBUG_SURFACE_HEIGHT_M,
  DEBUG_SURFACE_HEIGHT_PX,
  DEFAULT_RUNTIME_MEDIA_SURFACES,
  createMediaSurfaceMesh,
  applyMediaSurfaceTransform,
  createMediaSurfaceView,
  updateMediaSurfaceView,
  runtimeMediaSurfaceDefinitionFromScene,
  type RuntimeMediaSurfaceView
} from "./media/media-surface-view.js";
'''
for name in ['DEFAULT_MEDIA_SURFACE_ID', 'LAPTOP_MEDIA_SURFACE_ID', 'WHITEBOARD_MEDIA_SURFACE_ID', 'LEGACY_MEDIA_SURFACE_NEAR_CONTACT_DISTANCE_M']:
    line = f'  {name},\n'
    assert main.count(line) == 1
    main = main.replace(line, '', 1)
anchor = 'import { mediaSurfaceDimensionsChanged, planMediaSurfaceMismatches } from "./media/media-surface-layout.js";\n'
assert main.count(anchor) == 1
main = main.replace(anchor, anchor + main_import, 1)

# Undo every edit independently and require byte-for-byte recovery of the input.
recovered = main.replace(main_import, '', 1)
for name, anchor_line in [
    ('DEFAULT_MEDIA_SURFACE_ID', '  DISABLED_EXTENSION_CARD_TYPE,\n'),
    ('LAPTOP_MEDIA_SURFACE_ID', '  MARKDOWN_BOARD_OBJECT_TYPE,\n'),
    ('WHITEBOARD_MEDIA_SURFACE_ID', '  WHITEBOARD_MAX_POINTS_PER_STROKE,\n'),
    ('LEGACY_MEDIA_SURFACE_NEAR_CONTACT_DISTANCE_M', '  type SceneBundleMediaSurface,\n'),
]:
    assert recovered.count(anchor_line) == 1
    recovered = recovered.replace(anchor_line, f'  {name},\n' + anchor_line, 1)
for (start_marker, end_marker), block in zip(ranges, blocks):
    original_block = original[original.index(start_marker):original.index(end_marker, original.index(start_marker))]
    recovered = recovered.replace(end_marker, original_block + end_marker, 1)
assert recovered == original, 'inverse reconstruction differs'

new_path = root / 'apps/runtime-web/src/media/media-surface-view.ts'
assert not new_path.exists(), 'target module already exists'
new_path.write_text(module_imports + module)
main_path.write_text(main)
print(f'main.ts: {len(original.splitlines())} -> {len(main.splitlines())} lines')
print(f'media-surface-view.ts: {len((module_imports + module).splitlines())} lines')
print('Inverse reconstruction: exact')
