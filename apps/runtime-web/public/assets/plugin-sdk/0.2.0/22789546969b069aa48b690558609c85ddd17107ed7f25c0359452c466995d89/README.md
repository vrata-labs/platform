# Room plugin SDK 0.2.0

Immutable pnpm tarball for external plugin authors; SDK API/schema remain v1.

- File: vrata-room-plugin-sdk-0.2.0.tgz
- SHA-256: 22789546969b069aa48b690558609c85ddd17107ed7f25c0359452c466995d89
- Package: @vrata/room-plugin-sdk@0.2.0
- License: Apache-2.0
- Node.js: >=22

Copy the archive into an included standalone sample before installing. Samples
pin this local-file dependency and never fall back to an unrelated registry SDK.

The release adds browser-safe manifest/envelope parsing without Node crypto or
packaging imports. Hosts still verify both checksums; envelope parsing alone does
not authorize or execute source. The Node artifact entry retains syntax/hash
validation. Operation promises require a trusted broker acknowledgement.

The original 0.1.0 download remains immutable. Existing API-v1 artifacts stay
compatible; live auto-seat still requires the platform seating adapter.
