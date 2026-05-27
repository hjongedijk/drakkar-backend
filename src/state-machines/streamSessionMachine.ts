import { assign, createActor, setup } from "xstate";

export type StreamSessionSnapshot = {
  id: string;
  path: string;
  range: string;
  source: "http" | "fuse" | "api";
  userAgent: string;
  status: "opening" | "active" | "closed" | "cancelled" | "failed";
  bytesSent: number;
  currentOffset: number;
  size: number;
  start: number;
  end: number;
  fileId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  error?: string;
};

type StreamSessionInput = {
  id: string;
  path: string;
  range?: string;
  source?: "http" | "fuse" | "api";
  userAgent?: string;
};

type StreamSessionUpdate = Partial<Omit<StreamSessionSnapshot, "id" | "createdAt">>;

const streamSessionMachine = setup({
  types: {
    context: {} as StreamSessionSnapshot,
    input: {} as StreamSessionInput,
    events: {} as
      | { type: "READY" }
      | { type: "UPDATE"; payload: StreamSessionUpdate }
      | { type: "CLOSE"; payload?: StreamSessionUpdate }
      | { type: "CANCEL"; payload?: StreamSessionUpdate }
      | { type: "FAIL"; error: string; payload?: StreamSessionUpdate }
  },
  actions: {
    applyUpdate: assign(({ context, event }) => {
      if (!("payload" in event) || !event.payload) return { updatedAt: new Date().toISOString() };
      return {
        ...event.payload,
        updatedAt: new Date().toISOString(),
        bytesSent: event.payload.bytesSent ?? context.bytesSent,
        currentOffset: event.payload.currentOffset ?? context.currentOffset,
        size: event.payload.size ?? context.size,
        start: event.payload.start ?? context.start,
        end: event.payload.end ?? context.end
      };
    }),
    markReady: assign(() => ({
      status: "active" as const,
      updatedAt: new Date().toISOString()
    })),
    markClosed: assign(({ event }) => ({
      ...("payload" in event && event.payload ? event.payload : {}),
      status: "closed" as const,
      updatedAt: new Date().toISOString(),
      closedAt: new Date().toISOString()
    })),
    markCancelled: assign(({ event }) => ({
      ...("payload" in event && event.payload ? event.payload : {}),
      status: "cancelled" as const,
      updatedAt: new Date().toISOString(),
      closedAt: new Date().toISOString()
    })),
    markFailed: assign(({ event }) => ({
      ...("payload" in event && event.payload ? event.payload : {}),
      status: "failed" as const,
      error: "error" in event ? event.error : "stream session failed",
      updatedAt: new Date().toISOString(),
      closedAt: new Date().toISOString()
    }))
  }
}).createMachine({
  id: "streamSession",
  initial: "opening",
  context: ({ input }) => {
    const now = new Date().toISOString();
    return {
      id: input.id,
      path: input.path,
      range: input.range ?? "",
      source: input.source ?? "api",
      userAgent: input.userAgent ?? "",
      status: "opening",
      bytesSent: 0,
      currentOffset: 0,
      size: 0,
      start: 0,
      end: 0,
      createdAt: now,
      updatedAt: now
    };
  },
  states: {
    opening: {
      on: {
        READY: { target: "active", actions: "markReady" },
        FAIL: { target: "failed", actions: "markFailed" },
        CANCEL: { target: "cancelled", actions: "markCancelled" }
      }
    },
    active: {
      on: {
        UPDATE: { actions: "applyUpdate" },
        CLOSE: { target: "closed", actions: "markClosed" },
        CANCEL: { target: "cancelled", actions: "markCancelled" },
        FAIL: { target: "failed", actions: "markFailed" }
      }
    },
    closed: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" }
  }
});

const streamSessionActors = new Map<string, ReturnType<typeof createActor<typeof streamSessionMachine>>>();

export function startStreamSessionActor(input: StreamSessionInput) {
  const existing = streamSessionActors.get(input.id);
  if (existing) return existing;
  const actor = createActor(streamSessionMachine, { input });
  actor.start();
  actor.send({ type: "READY" });
  streamSessionActors.set(input.id, actor);
  return actor;
}

export function updateStreamSessionActor(sessionId: string, payload: StreamSessionUpdate) {
  streamSessionActors.get(sessionId)?.send({ type: "UPDATE", payload });
}

export function closeStreamSessionActor(sessionId: string, payload?: StreamSessionUpdate) {
  const actor = streamSessionActors.get(sessionId);
  if (!actor) return;
  actor.send({ type: "CLOSE", payload });
}

export function cancelStreamSessionActor(sessionId: string, payload?: StreamSessionUpdate) {
  const actor = streamSessionActors.get(sessionId);
  if (!actor) return;
  actor.send({ type: "CANCEL", payload });
}

export function failStreamSessionActor(sessionId: string, error: string, payload?: StreamSessionUpdate) {
  const actor = streamSessionActors.get(sessionId);
  if (!actor) return;
  actor.send({ type: "FAIL", error, payload });
}

export function getStreamSessionActorSnapshot(sessionId: string): StreamSessionSnapshot | null {
  return streamSessionActors.get(sessionId)?.getSnapshot().context ?? null;
}

export function stopStreamSessionActor(sessionId: string) {
  const actor = streamSessionActors.get(sessionId);
  if (!actor) return;
  actor.stop();
  streamSessionActors.delete(sessionId);
}
