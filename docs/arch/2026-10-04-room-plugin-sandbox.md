# Room plugin SDK and sandbox spike

## Contract and implementation

`@vrata/room-plugin-sdk@0.1.0` defines a versioned JSON artifact containing one
UTF-8 ESM entry, exact entry/whole-file SHA-256, explicit capabilities and flat
typed configuration. Its Node artifact validator rejects imports through Acorn
AST parsing; runtime DTO validation has no Node dependencies. The standalone
welcome-status example packs and installs without runtime source imports.

The spike executes ESM lifecycle exports only inside QuickJS WebAssembly in a
dedicated Worker. It is not the room plugin installation/binding product path:
author APIs, persistence, binding leases, authenticated broker responses and
seating correlation are the following T04–T10 tasks. The probe page accepts only
predefined diagnostic fixtures and carries no room/session credentials.

Pinned production dependencies are quickjs-emscripten-core and
@jitl/quickjs-wasmfile-release-sync, both 0.32.0. A trusted main-thread loader
compiles WASM once; each Worker receives the module and instantiates its own
bounded memory. No guest module loader, native eval, guest source import or
browser/network globals are provided. Static Worker assets are served with
default-src none, script-src wasm-unsafe-eval, connect-src none and worker-src
none. Vite emits a single Worker bundle without dynamic imports.

## Measured resource decision

- QuickJS heap: 16 MiB. WASM linear memory: initial 16 MiB, maximum 48 MiB.
- VM stack: **32 KiB**. The initial 256 KiB candidate exhausted Chromium's native
  call stack before VM handling. The pinned binary reserves 5 MiB linear C stack;
  that reservation is not a browser native-stack guarantee. Recursion, deep JSON
  parsing and nested native join are checked at the accepted lower limit.
- Trusted bundle/prepare: 3000 ms; guest handler/init: 50 ms; independent parent
  watchdog: 500 ms. Cumulative VM execution: 100 ms/s and 2 s/min.
- Job drain: at most 1024 jobs/turn; interrupt count bounded independently.
- DTOs: 16 KiB, depth 8 and 512 nodes. SDK requests: 10/s, queue 32; status 2/s.

Captured VM primordials serialize data before any native string copy. Getters,
toJSON, custom prototypes, cycles, excessive depth/size and reserved keys fail;
reflection and Proxy traps stay inside the interrupted VM. Host-side validation
independently checks approved capabilities and rate limits for the entire turn
before applying effects. Errors never dump guest values or run guest formatting
outside the budget. Memory/stack exception hints are explicitly untrusted, not
proof of the cause. Fatal failures terminate only that instance without restart.

## Verification gate

Node tests cover VM and supervisor failure transitions, cumulative limits,
capabilities, quotas, malformed protocol and lifecycle disposal. Compiled
Chromium probes cover CSP loading, absent browser globals/network, fake token
canaries, infinite loops, native regex, allocation/stack exhaustion, job storms,
message floods, poisoned primordials, getters, large results and forbidden
imports. A healthy companion and the page remain responsive during failure.
The same four scenarios are registered for local and published staging runs.

DEBUG_SYNC leak checks run 100 lifecycle cycles and hostile failures. Instrumented
debug execution needs a 64 KiB stack; this checks handle ownership, not acceptance
of the production release stack. Browser timings and WASM buffer sizes are probe
observations, not whole-renderer memory bounds or a performance SLA.

**T03 device gate remains open:** real Android/Quest latency, memory pressure and
disposal must be checked before open author-code execution is activated. Browser
device emulation cannot close that gate. Desktop results permit continuation of
T04–T10 implementation, not publication of author upload as completed functionality.
