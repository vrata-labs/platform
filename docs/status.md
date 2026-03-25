# Status

## Current phase

- Active phase: `M1 scaffold baseline complete`
- Overall state: `in_progress`

## Phase checklist

- [x] Create planning document for `M0 -> M1`
- [x] Create `docs/product-scope.md`
- [x] Create ADR set `001-006`
- [x] Create `docs/architecture.md`
- [x] Create initial monorepo skeleton directories
- [x] Add root workspace files: `package.json`, `pnpm-workspace.yaml`, `.gitignore`
- [x] Add baseline `.env.example`
- [x] Add baseline CI workflow for `lint`, `typecheck`, `build`
- [x] Add package-level app scaffolds
- [x] Validate scripts and CI after first package manifests are added
- [x] Add baseline API contracts document
- [x] Add dev/staging environment notes
- [x] Add basic API server with health, manifest, and token endpoints
- [x] Smoke-test API endpoints locally
- [x] Add runtime boot helpers and manifest loading scaffold
- [x] Add runtime-core lifecycle, overlay, manifest, and quality scaffolds
- [x] Add room-state schema and join helpers scaffold
- [x] Smoke-test runtime boot flow against local API
- [x] Add media-plane scaffold and voice session planning
- [x] Add media token acquisition flow in runtime scaffold
- [x] Add media-plane documentation and env surface
- [x] Smoke-test media token planning against local API
- [x] Add XR detection and hardening scaffolds
- [x] Add feature flag and telemetry helper scaffolds
- [x] Add in-memory control-plane CRUD for tenants, templates, rooms, and assets
- [x] Add template registry and space-manifest scaffold
- [x] Add asset validation and preset scaffolds
- [x] Add unit tests across apps and packages
- [x] Extend CI to run tests and asset-pipeline checks
- [x] Smoke-test control-plane tenant and room creation flow

## Notes

- Current repository state is greenfield with docs and skeleton only.
- `Phase 1` should stay time-boxed and must not redefine the product stack.
- `Phase 0` is complete enough to move into `M0` foundation work.
- Current API tokens are placeholder payloads and must be replaced with signed integrations before production use.
- Current progress covers typed scaffolds, contracts, tests, and local smoke flows through the planned `M1` seams.
- Real voice transport, spatial audio graph, XR session handling, persistent storage, auth, and browser UI rendering are still pending implementation.
- GitHub repository published: `https://github.com/psilon2000/noah`
- Current staging API health endpoint: `http://178.154.192.108:4000/health`
