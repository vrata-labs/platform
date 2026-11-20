/** Local debug observation only. Resource objects are WeakMap keys, never inspected or exported. */
export const MEDIA_LIFECYCLE_LIMITS = { generations: 8, events: 64 } as const;
const stages = ["connect", "devices", "install", "reconcile"] as const;
export type MediaLifecycleStage = typeof stages[number];
type Status = "not-started" | "pending" | "succeeded" | "failed";
type Relation = "attempt" | "current" | "invalidated";
const reasons = {
  subscription: ["room-not-current", "current-room"],
  "remote-browser-binding": ["identity-kind", "no-physical-object", "matched"],
  "screen-share-binding": ["binding-not-user", "binding-media-only", "no-physical-object", "matched"],
  "screen-share-attach": ["missing-surface", "reused", "registered"],
  "remote-browser-attach": ["missing-surface", "reused", "registered"],
  "screen-share-sdk-attach": ["returned", "threw"],
  "remote-browser-sdk-attach": ["returned", "threw"]
} as const;
type VerdictStage = keyof typeof reasons;
const invalidations = ["cleared", "disconnected", "replaced", "failed", "session-blocked", "discarded"] as const;
type Invalidation = typeof invalidations[number];
interface Phase { execution: number | null; status: Status; startedAtMs: number | null; completedAtMs: number | null }
interface Generation {
  generation: number;
  relation: Relation;
  createdAtMs: number | null;
  invalidatedAtMs: number | null;
  invalidationReason: Invalidation | null;
  stages: Record<MediaLifecycleStage, Phase>;
}
interface Event {
  generation: number;
  execution: number | null;
  relation: Relation;
  atMs: number | null;
  stage: MediaLifecycleStage | VerdictStage | "generation";
  outcome: Status | "created" | "invalidated" | "accepted" | "rejected";
  reason: string | null;
}
export interface MediaLifecycleSnapshot {
  schema: 1;
  clock: "performance.now";
  clockValid: boolean;
  observedAtMs: number | null;
  latestGeneration: number | null;
  currentGeneration: number | null;
  droppedGenerations: number;
  droppedEvents: number;
  generations: Generation[];
  events: Event[];
}

export function createMediaLifecycleDiagnostics(enabled: boolean, now: () => number = () => performance.now()) {
  const keys = new WeakMap<object, number>();
  const history: Generation[] = [];
  const events: Event[] = [];
  const verdicts = new Map<number, Partial<Record<VerdictStage, string>>>();
  // Handles live only as long as their actual callers; no retained per-execution history.
  const executions = new WeakMap<object, { item: Generation; stage: MediaLifecycleStage; execution: number | null; completed: boolean }>();
  const latestExecutions = new WeakMap<Phase, object>();
  let latestGeneration: number | null = null, currentGeneration: number | null = null;
  let droppedGenerations = 0, droppedEvents = 0, lastTime = 0, clockValid = true;
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const time = (): number | null => {
    try {
      const value = now();
      if (Number.isFinite(value) && value >= lastTime && value <= Number.MAX_SAFE_INTEGER) {
        lastTime = value;
        return value;
      }
    } catch { /* A broken diagnostic clock must not change the observed operation. */ }
    clockValid = false;
    return null;
  };
  const find = (room: object | null) => enabled && room ? history.find(item => item.generation === keys.get(room)) : undefined;
  const emit = (item: Generation, stage: Event["stage"], outcome: Event["outcome"], reason: string | null = null, atMs = time(), execution: number | null = null) => {
    if (events.length === MEDIA_LIFECYCLE_LIMITS.events) { events.shift(); droppedEvents = increment(droppedEvents); }
    events.push({ generation: item.generation, execution, relation: item.relation, atMs, stage, outcome, reason });
  };
  const invalidateItem = (item: Generation, reason: Invalidation) => {
    if (item.relation === "invalidated") return;
    item.relation = "invalidated";
    item.invalidatedAtMs = time();
    item.invalidationReason = reason;
    if (currentGeneration === item.generation) currentGeneration = null;
    emit(item, "generation", "invalidated", reason, item.invalidatedAtMs);
  };
  return {
    created(room: object): void {
      if (!enabled || keys.has(room) || latestGeneration === Number.MAX_SAFE_INTEGER) return;
      latestGeneration = increment(latestGeneration ?? 0);
      keys.set(room, latestGeneration);
      const item: Generation = { generation: latestGeneration, relation: "attempt", createdAtMs: time(),
        invalidatedAtMs: null, invalidationReason: null,
        stages: Object.fromEntries(stages.map(stage => [stage, { execution: null, status: "not-started", startedAtMs: null, completedAtMs: null }])) as Generation["stages"] };
      if (history.length === MEDIA_LIFECYCLE_LIMITS.generations) {
        const index = history.findIndex(previous => previous.generation !== currentGeneration);
        const [removed] = history.splice(index, 1);
        verdicts.delete(removed!.generation);
        droppedGenerations = increment(droppedGenerations);
      }
      history.push(item);
      emit(item, "generation", "created", null, item.createdAtMs);
    },
    start(room: object, stage: MediaLifecycleStage): object | null {
      const item = find(room);
      if (!item || !stages.includes(stage)) return null;
      const phase = item.stages[stage];
      // Null after ordinal exhaustion is explicit; handle identity still correlates completions.
      const execution = phase.status === "not-started" ? 1
        : phase.execution === null || phase.execution === Number.MAX_SAFE_INTEGER ? null : phase.execution + 1;
      const handle = {};
      executions.set(handle, { item, stage, execution, completed: false });
      latestExecutions.set(phase, handle);
      phase.execution = execution; phase.status = "pending"; phase.startedAtMs = time(); phase.completedAtMs = null;
      emit(item, stage, "pending", null, phase.startedAtMs, execution);
      return handle;
    },
    finish(room: object, stage: MediaLifecycleStage, outcome: "succeeded" | "failed", handle: object | null): void {
      const item = find(room);
      const run = handle && executions.get(handle);
      if (!item || !run || run.item !== item || run.stage !== stage || run.completed
        || outcome !== "succeeded" && outcome !== "failed") return;
      run.completed = true;
      const phase = item.stages[stage];
      const completedAtMs = time();
      if (latestExecutions.get(phase) === handle) {
        phase.status = outcome; phase.completedAtMs = completedAtMs;
      }
      emit(item, stage, outcome, null, completedAtMs, run.execution);
    },
    installed(room: object): void {
      const item = find(room);
      if (!item || item.relation === "invalidated") return;
      for (const previous of history) if (previous.generation === currentGeneration && previous !== item) invalidateItem(previous, "replaced");
      currentGeneration = item.generation;
      item.relation = "current";
    },
    invalidate(room: object, reason: Invalidation): void {
      const item = find(room);
      if (item && invalidations.includes(reason)) invalidateItem(item, reason);
    },
    invalidateAll(): void {
      for (const item of history) invalidateItem(item, "session-blocked");
    },
    verdict<S extends VerdictStage>(room: object | null, stage: S, accepted: boolean, reason: typeof reasons[S][number]): void {
      const item = find(room);
      if (!item || !Object.hasOwn(reasons, stage) || !(reasons[stage] as readonly string[]).includes(reason)) return;
      const value = `${item.relation}:${accepted}:${reason}`;
      const previous = verdicts.get(item.generation) ?? {};
      if (previous[stage] === value) return;
      previous[stage] = value;
      verdicts.set(item.generation, previous);
      emit(item, stage, accepted ? "accepted" : "rejected", reason);
    },
    snapshot(): MediaLifecycleSnapshot | null {
      if (!enabled) return null;
      const observedAtMs = time();
      return { schema: 1, clock: "performance.now", clockValid, observedAtMs, latestGeneration, currentGeneration,
        droppedGenerations, droppedEvents,
        generations: history.map(item => ({ ...item, stages: Object.fromEntries(stages.map(stage => [stage, { ...item.stages[stage] }])) as Generation["stages"] })),
        events: events.map(event => ({ ...event })) };
    }
  };
}
