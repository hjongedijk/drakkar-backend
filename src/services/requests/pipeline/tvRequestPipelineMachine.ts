import { assign, createActor, fromPromise, setup, waitFor } from "xstate";

export type TvRequestSeasonWork<TSeasonContext = unknown> = TSeasonContext;

export type TvRequestGrabResult = {
  grabbed: boolean;
  reason?: string;
  seasons?: unknown[];
  remainingSeasonSearches?: number;
  [key: string]: unknown;
};

type TvRequestPipelineInput<TRequest, TBroadRelease, TSeasonContext, TSeasonResult> = {
  handlers: {
    loadRequest: () => Promise<TRequest>;
    prepare: (request: TRequest) => Promise<{
      terminal?: TvRequestGrabResult | null;
      seasonsNeedingSearch?: TSeasonContext[];
    }>;
    loadBroadReleases: (request: TRequest) => Promise<TBroadRelease[]>;
    processSeason: (input: {
      request: TRequest;
      season: TSeasonContext;
      broadReleases: TBroadRelease[];
    }) => Promise<TSeasonResult>;
    finalize: (input: {
      request: TRequest;
      seasonResults: Array<{ season: TSeasonContext; result: TSeasonResult }>;
      totalSeasonsNeedingSearch: number;
    }) => Promise<TvRequestGrabResult>;
  };
};

type TvRequestPipelineContext<TRequest, TBroadRelease, TSeasonContext, TSeasonResult> = {
  request: TRequest | null;
  seasonsNeedingSearch: TSeasonContext[];
  broadReleases: TBroadRelease[];
  currentIndex: number;
  seasonResults: Array<{ season: TSeasonContext; result: TSeasonResult }>;
  terminal: TvRequestGrabResult | null;
};

type EventWithOutput<T> = { output: T };

function getEventOutput<T>(event: unknown): T | null {
  if (!event || typeof event !== "object" || !("output" in event)) return null;
  return (event as EventWithOutput<T>).output;
}

export async function runTvRequestGrabPipeline<TRequest, TBroadRelease, TSeasonContext, TSeasonResult>(input: TvRequestPipelineInput<TRequest, TBroadRelease, TSeasonContext, TSeasonResult>) {
  const machine = setup({
    types: {
      context: {} as TvRequestPipelineContext<TRequest, TBroadRelease, TSeasonContext, TSeasonResult>,
      input: {} as TvRequestPipelineInput<TRequest, TBroadRelease, TSeasonContext, TSeasonResult>,
      events: {} as { type: "noop" }
    },
    actors: {
      loadRequest: fromPromise(async () => input.handlers.loadRequest()),
      prepare: fromPromise(async ({ input: actorInput }: { input: { request: TRequest } }) => input.handlers.prepare(actorInput.request)),
      loadBroadReleases: fromPromise(async ({ input: actorInput }: { input: { request: TRequest } }) => input.handlers.loadBroadReleases(actorInput.request)),
      processSeason: fromPromise(async ({ input: actorInput }: { input: { request: TRequest; season: TSeasonContext; broadReleases: TBroadRelease[] } }) =>
        input.handlers.processSeason(actorInput)
      ),
      finalize: fromPromise(async ({ input: actorInput }: { input: { request: TRequest; seasonResults: Array<{ season: TSeasonContext; result: TSeasonResult }>; totalSeasonsNeedingSearch: number } }) =>
        input.handlers.finalize(actorInput)
      )
    },
    guards: {
      hasTerminal: ({ event }) => Boolean(getEventOutput<{ terminal?: TvRequestGrabResult | null }>(event)?.terminal),
      hasSeasons: ({ context }) => context.seasonsNeedingSearch.length > 0,
      moreSeasonsRemain: ({ context }) => context.currentIndex + 1 < context.seasonsNeedingSearch.length
    },
    actions: {
      setRequest: assign(({ event }) => ({ request: getEventOutput<TRequest>(event) })),
      setPreparedState: assign(({ event }) => {
        const output = getEventOutput<{ terminal?: TvRequestGrabResult | null; seasonsNeedingSearch?: TSeasonContext[] }>(event);
        return {
          terminal: output?.terminal ?? null,
          seasonsNeedingSearch: output?.seasonsNeedingSearch ?? []
        };
      }),
      setBroadReleases: assign(({ event }) => ({ broadReleases: getEventOutput<TBroadRelease[]>(event) ?? [] })),
      appendSeasonResult: assign(({ event, context }) => {
        const result = getEventOutput<TSeasonResult>(event);
        const season = context.seasonsNeedingSearch[context.currentIndex] as TSeasonContext;
        if (!result) return {};
        return {
          currentIndex: context.currentIndex + 1,
          seasonResults: [...context.seasonResults, { season, result }]
        };
      }),
      setTerminalResult: assign(({ event }) => ({ terminal: getEventOutput<TvRequestGrabResult>(event) }))
    }
  }).createMachine({
    id: "tvRequestGrabPipeline",
    context: {
      request: null,
      seasonsNeedingSearch: [],
      broadReleases: [],
      currentIndex: 0,
      seasonResults: [],
      terminal: null
    },
    initial: "loadingRequest",
    states: {
      loadingRequest: {
        invoke: {
          src: "loadRequest",
          onDone: { target: "preparing", actions: "setRequest" }
        }
      },
      preparing: {
        invoke: {
          src: "prepare",
          input: ({ context }) => ({ request: context.request as TRequest }),
          onDone: [
            { guard: "hasTerminal", target: "done", actions: "setPreparedState" },
            { target: "loadingBroadReleases", actions: "setPreparedState" }
          ]
        }
      },
      loadingBroadReleases: {
        always: [
          { guard: "hasSeasons", target: "runningBroadReleaseLoad" },
          { target: "finalizing" }
        ]
      },
      runningBroadReleaseLoad: {
        invoke: {
          src: "loadBroadReleases",
          input: ({ context }) => ({ request: context.request as TRequest }),
          onDone: { target: "processingSeason", actions: "setBroadReleases" }
        }
      },
      processingSeason: {
        invoke: {
          src: "processSeason",
          input: ({ context }) => ({
            request: context.request as TRequest,
            season: context.seasonsNeedingSearch[context.currentIndex] as TSeasonContext,
            broadReleases: context.broadReleases
          }),
          onDone: [
            { guard: "moreSeasonsRemain", target: "processingSeason", actions: "appendSeasonResult" },
            { target: "finalizing", actions: "appendSeasonResult" }
          ]
        }
      },
      finalizing: {
        invoke: {
          src: "finalize",
          input: ({ context }) => ({
            request: context.request as TRequest,
            seasonResults: context.seasonResults,
            totalSeasonsNeedingSearch: context.seasonsNeedingSearch.length
          }),
          onDone: { target: "done", actions: "setTerminalResult" }
        }
      },
      done: {
        type: "final"
      }
    }
  });

  const actor = createActor(machine, { input });
  try {
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === "done");
    return actor.getSnapshot().context.terminal as TvRequestGrabResult;
  } finally {
    actor.stop();
  }
}
