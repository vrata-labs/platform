from pathlib import Path
import hashlib, json, sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
main_path = root / 'apps/runtime-web/src/main.ts'
original = main_path.read_text()
assert hashlib.sha256(original.encode()).hexdigest() == '922f5a10c938cd05ebf5af9de2535dc6a7b995453804ad3b7c55e5dc67d4c8b2'
start = original.index('function createMockShareStream(): MediaStream {')
end = original.index('function detachVideoTrack(track?: Track): void {', start)
block = original[start:end]
assert block.count('function ') == 2
module = ('import { Track, type Room } from "livekit-client";\n\n'
          'import { createFaultError } from "../runtime-errors.js";\n\n'
          + block.replace('function createMockShareStream()', 'export function createMockShareStream()', 1)
                 .replace('async function captureAndPublishScreenShareStream(', 'export async function captureAndPublishScreenShareStream(', 1).rstrip() + '\n')
anchor = 'import { getScreenShareErrorCode } from "./media/screen-share-object.js";\n'
assert original.count(anchor) == 1
new_import = 'import { captureAndPublishScreenShareStream, createMockShareStream } from "./media/screen-share-capture.js";\n'
candidate = (original[:start] + original[end:]).replace(anchor, anchor + new_import, 1)
restored = candidate.replace(new_import, '', 1).replace('function detachVideoTrack(track?: Track): void {', block + 'function detachVideoTrack(track?: Track): void {', 1)
assert restored == original
module_path = main_path.parent / 'media/screen-share-capture.ts'
assert not module_path.exists()
module_path.write_text(module)
main_path.write_text(candidate)
print(json.dumps({'baseline_lines':len(original.splitlines()),'candidate_lines':len(candidate.splitlines()),'module_lines':len(module.splitlines()),'original_sha256':hashlib.sha256(original.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'inverse_reconstruction': True}, indent=2))
