# Control Plane

## Current baseline

- In-memory backend CRUD exists for templates, tenants, rooms, and assets.
- Control-plane client scaffolds can fetch templates, create rooms, and upload assets.
- Room creation returns a generated room link and manifest.

## Current limitations

- No persistent storage yet.
- No auth or role checks yet.
- No real UI rendering yet; current layer is a typed client scaffold.
