import { PluginVm, type VmTurn } from "./vm.js";

/** Unit-only trusted status broker. Older containment/ABI tests still exercise
 * the real async VM protocol; they never turn the bootstrap back into local ACK. */
function settle(vm: PluginVm, first: VmTurn): VmTurn {
  let current = first, executionMs = first.executionMs, jobs = first.jobs;
  const requests = [...first.requests];
  for (let round = 0; current.lifecycle === "pending"; round++) {
    if (round >= 32 || !current.requests.length) throw new Error("test_broker_unsettled");
    current = vm.respond(JSON.stringify(current.requests.map(request => ({ sdkApiVersion: 1, requestId: request.requestId,
      ...(request.operation === "status.set" ? { ok: true, result: null } : { ok: false, error: "capability-denied" }) }))));
    requests.push(...current.requests); executionMs += current.executionMs; jobs += current.jobs;
  }
  return { ...current, requests, executionMs, jobs };
}

export class StatusAcknowledgingPluginVm extends PluginVm {
  override init(...args: Parameters<PluginVm["init"]>): VmTurn { return settle(this, super.init(...args)); }
  override event(...args: Parameters<PluginVm["event"]>): VmTurn { return settle(this, super.event(...args)); }
  override dispose(): VmTurn { return settle(this, super.dispose()); }
}
