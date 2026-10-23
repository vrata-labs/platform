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

The manual probe now labels each fixed scenario in Russian, shows its purpose
and expected outcome, and separates the PASS/FAIL verdict from the plugin's
state. A hostile instance is expected to enter failed; healthy, globals and
primordial-tamper instances must complete without a failure. Matching codes on
the wrong init/event/dispose phase do not pass. Import observations do not by
themselves prove the cause of denial or replace automatic network/CSP checks.

One-button full runs cover all fixed fixtures and record concurrent companion
ACKs, visible frame samples/gaps and browser-trusted input during the run.
After-run clicks cannot close during-responsiveness or mutate its finished delay
measurements. The downloadable whitelist JSON contains no room credentials,
private context or arbitrary guest output. Manual device category/UA is
provenance, not automatic proof of the full device gate. A slow healthy init is
FAIL, not an expected hostile stop; the VM budget is not raised to hide it.

Cold-first-use profiling exposed startup work entering the guest 50 ms budget.
Trusted prepare now warms fixed ESM/FFI/Promise/status paths in a separate
context/runtime under the existing 3 s prepare deadline, then fully destroys
that realm. Guest callbacks, approvals, requests and execution counters are
never reused. The guest heap/stack/linear-memory/50 ms/watchdog limits remain
unchanged. Real Chromium profiling after the change observed 120 healthy/globals
initializations without timeout; this observation is not a device guarantee.

DEBUG_SYNC leak checks run 100 lifecycle cycles and hostile failures. Instrumented
debug execution needs a 64 KiB stack; this checks handle ownership, not acceptance
of the production release stack. Browser timings and WASM buffer sizes are probe
observations, not whole-renderer memory bounds or a performance SLA.

### Fixed-source resource campaign

The same diagnostic page offers a separate resource-benchmark report. It runs
100 sequential production Worker init/event/dispose cycles while a second healthy
instance remains alive, then 60 seconds of healthy event traffic. Two additional
fixed programs consume about 30 ms/12 ms per event on real clocks to observe the
existing second/minute cumulative stops. Events and companion pings are spaced
at least 250 ms; successful guest turns still use the unchanged 50 ms budget.
Only the matching cumulative code on EVENT is expected; ordinary initialization,
wrong-phase, watchdog or handler failures cannot stand in for that observation.

The campaign is bounded to five minutes and can be cancelled. Cancellation,
page hiding or insufficient DURING input leaves it incomplete, not certified.
Unexpected healthy/companion failures remain FAIL. Cleanup closes only owned
supervisors and retains partial evidence; counters are not physical-GC proof.
Normal full-scenario hidden-page semantics are unchanged.

The whitelist JSON includes per-cycle parent round-trip and VM execution timing,
count/min/median/nearest-rank-p95/max summaries, concurrent companion ACKs and
simultaneously observed PRIMARY/companion linear-buffer sizes. Init round-trip
includes Worker loading and trusted prepare. Rejected turn timing is unavailable
and is never fabricated; parent ACK timestamps do not reconstruct the VM's
rolling clock. Combined linear bytes are not heap usage or total browser memory.
Browser memory is recorded only through measureUserAgentSpecificMemory when
available; absent/error/timed-out measurements stay null/NOT_MEASURED. The page
does not add cross-origin isolation headers to make that API available.

The device selector includes Android Chrome, Quest and Windows as manual labels.
Both report scopes always retain deviceGate=NOT_EVALUATED. Save model, OS,
browser version, deployed SHA and physical-device provenance separately; the
resource report complements the 37-scenario report and does not replace it.

**T03 decision: GO, accepted on 2026-10-06.** Real-device reports cover Quest 2 /
OculusBrowser 149 and Android Chrome 154 against the published
9506de30b7f379e086c5db243dbbb398883693ae. Both completed all 37 fixed scenarios,
100 dual-instance lifecycle cycles, the healthy sustained workload and both
cumulative CPU stops. Quest reports include trusted DURING input and PASS.
Android technical checks passed; its missing DURING click was explicitly accepted
by the user through manual acceptance after reviewing the four reports.

The Android exports remain INCOMPLETE with zero DURING clicks and null input delay;
report deviceGate remains NOT_EVALUATED. This manual decision does not manufacture
an input measurement, total-browser memory measurement or physical-GC proof.
Evidence, source checksums and the acceptance decision are recorded in
[the implementation journal](../reviews/2026-09-26-working-meeting-implementation.md#t03-ручная-приёмка-и-закрытие).
Browser device emulation alone is not acceptance. Open author-code execution
still requires the independent T01a identity prerequisite and T05/T07 checks;
closing T03 does not activate the global identity floor or implement those paths.
