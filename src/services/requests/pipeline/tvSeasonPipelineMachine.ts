import { assign, createActor, fromPromise, setup, waitFor } from "xstate";

export type TvSeasonGrabResult = {
  grabbed: boolean;
  reason?: string;
  mode?: string;
  queued: unknown[];
  rejected: string[];
  transient?: boolean;
};

type TvSeasonPipelineInput<TPrepared, TRelease, TCandidate> = {
  handlers: {
    checkCooldown: () => Promise<TvSeasonGrabResult | null>;
    prepare: () => Promise<TPrepared>;
    loadReleases: (prepared: TPrepared) => Promise<TRelease[]>;
    scoreReleases: (prepared: TPrepared, releases: TRelease[]) => Promise<{ accepted: TCandidate[]; seasonPacks: TCandidate[] }>;
    processSeasonPacks: (input: {
      prepared: TPrepared;
      accepted: TCandidate[];
      seasonPacks: TCandidate[];
    }) => Promise<{ terminal?: TvSeasonGrabResult; queued: unknown[]; rejected: string[]; attemptedFetches: number }>;
    searchEpisodes: (input: {
      prepared: TPrepared;
      accepted: TCandidate[];
    }) => Promise<TCandidate[]>;
    processEpisodeCandidates: (input: {
      prepared: TPrepared;
      episodeCandidates: TCandidate[];
      queued: unknown[];
      rejected: string[];
      attemptedFetches: number;
    }) => Promise<TvSeasonGrabResult>;
    buildNoCandidateResult: (prepared: TPrepared) => Promise<TvSeasonGrabResult>;
  };
};

type TvSeasonPipelineContext<TPrepared, TRelease, TCandidate> = {
  prepared: TPrepared | null;
  releases: TRelease[];
  accepted: TCandidate[];
  seasonPacks: TCandidate[];
  episodeCandidates: TCandidate[];
  queued: unknown[];
  rejected: string[];
  attemptedFetches: number;
  result: TvSeasonGrabResult | null;
};

type EventWithOutput<T> = { output: T };

function getEventOutput<T>(event: unknown): T | null {
  if (!event || typeof event !== "object" || !("output" in event)) return null;
  return (event as EventWithOutput<T>).output;
}

export async function runTvSeasonGrabPipeline<TPrepared, TRelease, TCandidate>(input: TvSeasonPipelineInput<TPrepared, TRelease, TCandidate>) {
  const machine = setup({
    types: {
      context: {} as TvSeasonPipelineContext<TPrepared, TRelease, TCandidate>,
      input: {} as TvSeasonPipelineInput<TPrepared, TRelease, TCandidate>,
      events: {} as { type: "noop" }
    },
    actors: {
      checkCooldown: fromPromise(async () => input.handlers.checkCooldown()),
      prepare: fromPromise(async () => input.handlers.prepare()),
      loadReleases: fromPromise(async ({ input: actorInput }: { input: { prepared: TPrepared } }) => input.handlers.loadReleases(actorInput.prepared)),
      scoreReleases: fromPromise(async ({ input: actorInput }: { input: { prepared: TPrepared; releases: TRelease[] } }) =>
        input.handlers.scoreReleases(actorInput.prepared, actorInput.releases)
      ),
      processSeasonPacks: fromPromise(async ({ input: actorInput }: { input: { prepared: TPrepared; accepted: TCandidate[]; seasonPacks: TCandidate[] } }) =>
        input.handlers.processSeasonPacks(actorInput)
      ),
      searchEpisodes: fromPromise(async ({ input: actorInput }: { input: { prepared: TPrepared; accepted: TCandidate[] } }) => input.handlers.searchEpisodes(actorInput)),
      processEpisodeCandidates: fromPromise(async ({ input: actorInput }: { input: { prepared: TPrepared; episodeCandidates: TCandidate[]; queued: unknown[]; rejected: string[]; attemptedFetches: number } }) =>
        input.handlers.processEpisodeCandidates(actorInput)
      ),
      buildNoCandidateResult: fromPromise(async ({ input: actorInput }: { input: { prepared: TPrepared } }) => input.handlers.buildNoCandidateResult(actorInput.prepared))
    },
    guards: {
      hasTerminalCooldown: ({ event }) => Boolean(getEventOutput<TvSeasonGrabResult | null>(event)),
      hasSeasonPacks: ({ context }) => context.seasonPacks.length > 0,
      seasonPackTerminal: ({ event }) => Boolean(getEventOutput<{ terminal?: TvSeasonGrabResult }>(event)?.terminal),
      hasEpisodeCandidates: ({ context }) => context.episodeCandidates.length > 0
    },
    actions: {
      setResult: assign(({ event }) => {
        const result =
          getEventOutput<TvSeasonGrabResult | null>(event)
          ?? getEventOutput<TvSeasonGrabResult>(event)
          ?? getEventOutput<{ terminal?: TvSeasonGrabResult }>(event)?.terminal
          ?? null;
        return result ? { result } : {};
      }),
      setPrepared: assign(({ event }) => ({ prepared: getEventOutput<TPrepared>(event) })),
      setReleases: assign(({ event }) => ({ releases: getEventOutput<TRelease[]>(event) ?? [] })),
      setAccepted: assign(({ event }) => {
        const output = getEventOutput<{ accepted: TCandidate[]; seasonPacks: TCandidate[] }>(event);
        return {
          accepted: output?.accepted ?? [],
          seasonPacks: output?.seasonPacks ?? []
        };
      }),
      absorbSeasonPackResult: assign(({ event }) => {
        const output = getEventOutput<{ terminal?: TvSeasonGrabResult; queued: unknown[]; rejected: string[]; attemptedFetches: number }>(event);
        return output
          ? {
              queued: output.queued,
              rejected: output.rejected,
              attemptedFetches: output.attemptedFetches
            }
          : {};
      }),
      setEpisodeCandidates: assign(({ event }) => ({ episodeCandidates: getEventOutput<TCandidate[]>(event) ?? [] }))
    }
  }).createMachine({
    id: "tvSeasonGrabPipeline",
    context: {
      prepared: null,
      releases: [],
      accepted: [],
      seasonPacks: [],
      episodeCandidates: [],
      queued: [],
      rejected: [],
      attemptedFetches: 0,
      result: null
    },
    initial: "checkingCooldown",
    states: {
      checkingCooldown: {
        invoke: {
          src: "checkCooldown",
          onDone: [
            { guard: "hasTerminalCooldown", target: "done", actions: "setResult" },
            { target: "preparing" }
          ]
        }
      },
      preparing: {
        invoke: {
          src: "prepare",
          onDone: { target: "loadingReleases", actions: "setPrepared" }
        }
      },
      loadingReleases: {
        invoke: {
          src: "loadReleases",
          input: ({ context }) => ({ prepared: context.prepared as TPrepared }),
          onDone: { target: "scoring", actions: "setReleases" }
        }
      },
      scoring: {
        invoke: {
          src: "scoreReleases",
          input: ({ context }) => ({
            prepared: context.prepared as TPrepared,
            releases: context.releases
          }),
          onDone: { target: "processingSeasonPacks", actions: "setAccepted" }
        }
      },
      processingSeasonPacks: {
        always: [
          { guard: "hasSeasonPacks", target: "runningSeasonPackPass" },
          { target: "searchingEpisodes" }
        ]
      },
      runningSeasonPackPass: {
        invoke: {
          src: "processSeasonPacks",
          input: ({ context }) => ({
            prepared: context.prepared as TPrepared,
            accepted: context.accepted,
            seasonPacks: context.seasonPacks
          }),
          onDone: [
            { guard: "seasonPackTerminal", target: "done", actions: ["absorbSeasonPackResult", "setResult"] },
            { target: "searchingEpisodes", actions: "absorbSeasonPackResult" }
          ]
        }
      },
      searchingEpisodes: {
        invoke: {
          src: "searchEpisodes",
          input: ({ context }) => ({
            prepared: context.prepared as TPrepared,
            accepted: context.accepted
          }),
          onDone: { target: "processingEpisodeCandidates", actions: "setEpisodeCandidates" }
        }
      },
      processingEpisodeCandidates: {
        always: [
          { guard: "hasEpisodeCandidates", target: "runningEpisodePass" },
          { target: "buildingNoCandidateResult" }
        ]
      },
      runningEpisodePass: {
        invoke: {
          src: "processEpisodeCandidates",
          input: ({ context }) => ({
            prepared: context.prepared as TPrepared,
            episodeCandidates: context.episodeCandidates,
            queued: context.queued,
            rejected: context.rejected,
            attemptedFetches: context.attemptedFetches
          }),
          onDone: { target: "done", actions: "setResult" }
        }
      },
      buildingNoCandidateResult: {
        invoke: {
          src: "buildNoCandidateResult",
          input: ({ context }) => ({ prepared: context.prepared as TPrepared }),
          onDone: { target: "done", actions: "setResult" }
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
    return actor.getSnapshot().context.result as TvSeasonGrabResult;
  } finally {
    actor.stop();
  }
}
