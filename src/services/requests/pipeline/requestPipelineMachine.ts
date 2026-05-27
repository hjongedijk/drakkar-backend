import { assign, createActor, fromPromise, setup, waitFor } from "xstate";

export type RequestPipelineResult = {
  grabbed: boolean;
  reason: string;
  [key: string]: unknown;
};

export type RequestPipelineCandidate<TCandidate = unknown> = TCandidate;

export type RequestPipelineAttemptResult = RequestPipelineResult & {
  attemptedFetch?: boolean;
  retryableFailure?: boolean;
  stop?: boolean;
};

type RequestPipelineHandlers<TCandidate> = {
  checkExisting: () => Promise<RequestPipelineResult | null>;
  loadCandidates: () => Promise<{ terminal?: RequestPipelineResult | null; candidates?: TCandidate[] }>;
  tryCandidate: (candidate: TCandidate, attemptNumber: number) => Promise<RequestPipelineAttemptResult>;
  onExhausted: (input: { rejected: string[]; attemptedFetches: number; candidates: TCandidate[] }) => Promise<RequestPipelineResult>;
};

type RequestPipelineInput<TCandidate> = {
  maxAttempts: number;
  handlers: RequestPipelineHandlers<TCandidate>;
};

type RequestPipelineContext<TCandidate> = {
  candidates: TCandidate[];
  currentIndex: number;
  attemptedFetches: number;
  rejected: string[];
  result: RequestPipelineResult | null;
};

type RequestPipelineEvent = { type: "noop" };

type EventWithOutput<T> = {
  output: T;
};

function getEventOutput<T>(event: unknown): T | null {
  if (!event || typeof event !== "object" || !("output" in event)) return null;
  return (event as EventWithOutput<T>).output;
}

export async function runRequestGrabPipeline<TCandidate>(input: RequestPipelineInput<TCandidate>) {
  const machine = setup({
    types: {
      context: {} as RequestPipelineContext<TCandidate>,
      events: {} as RequestPipelineEvent,
      input: {} as RequestPipelineInput<TCandidate>
    },
    actors: {
      checkExisting: fromPromise(async ({ input }: { input: RequestPipelineInput<TCandidate> }) => input.handlers.checkExisting()),
      loadCandidates: fromPromise(async ({ input }: { input: RequestPipelineInput<TCandidate> }) => input.handlers.loadCandidates()),
      tryCandidate: fromPromise(async ({ input }: { input: RequestPipelineInput<TCandidate> & { candidate: TCandidate; attemptNumber: number } }) =>
        input.handlers.tryCandidate(input.candidate, input.attemptNumber)
      ),
      buildExhaustedResult: fromPromise(async ({ input }: { input: { handlers: RequestPipelineHandlers<TCandidate>; rejected: string[]; attemptedFetches: number; candidates: TCandidate[] } }) =>
        input.handlers.onExhausted({
          rejected: input.rejected,
          attemptedFetches: input.attemptedFetches,
          candidates: input.candidates
        })
      )
    },
    guards: {
      hasExistingTerminal: ({ event }) => {
        const output = getEventOutput<RequestPipelineResult | null>(event);
        return Boolean(
          output
          && typeof output === "object"
          && "grabbed" in output
          && typeof output.grabbed === "boolean"
        );
      },
      hasLoadedTerminal: ({ event }) => Boolean(getEventOutput<{ terminal?: RequestPipelineResult | null; candidates?: TCandidate[] }>(event)?.terminal),
      hasCandidateList: ({ event }) => {
        const output = getEventOutput<{ terminal?: RequestPipelineResult | null; candidates?: TCandidate[] }>(event);
        return Boolean(output?.candidates?.length);
      },
      candidateGrabbed: ({ event }) => Boolean(getEventOutput<RequestPipelineAttemptResult>(event)?.grabbed),
      retryableFailure: ({ event }) => Boolean(getEventOutput<RequestPipelineAttemptResult>(event)?.retryableFailure),
      shouldStop: ({ event, context }) => {
        const output = getEventOutput<RequestPipelineAttemptResult>(event);
        if (output?.stop) return true;
        const nextAttempts = context.attemptedFetches + (output?.attemptedFetch ? 1 : 0);
        const nextIndex = context.currentIndex + 1;
        return nextAttempts >= input.maxAttempts || nextIndex >= context.candidates.length;
      }
    },
    actions: {
      setTerminalResult: assign(({ event }) => {
        const output =
          getEventOutput<RequestPipelineResult | null>(event)
          ?? getEventOutput<{ terminal?: RequestPipelineResult | null }>(event)?.terminal
          ?? getEventOutput<RequestPipelineAttemptResult>(event);
        return output ? { result: output } : {};
      }),
      setCandidates: assign(({ event }) => {
        const output = getEventOutput<{ terminal?: RequestPipelineResult | null; candidates?: TCandidate[] }>(event);
        return {
          candidates: output?.candidates ?? [],
          currentIndex: 0
        };
      }),
      recordFailure: assign(({ event, context }) => {
        const output = getEventOutput<RequestPipelineAttemptResult>(event);
        if (!output) return {};
        const rejected = output.reason ? [...context.rejected, output.reason] : context.rejected;
        return {
          rejected,
          attemptedFetches: context.attemptedFetches + (output.attemptedFetch ? 1 : 0),
          currentIndex: context.currentIndex + 1
        };
      })
    }
  }).createMachine({
    id: "requestGrabPipeline",
    context: {
      candidates: [],
      currentIndex: 0,
      attemptedFetches: 0,
      rejected: [],
      result: null
    },
    initial: "checkingExisting",
    states: {
      checkingExisting: {
        invoke: {
          src: "checkExisting",
          input: () => input,
          onDone: [
            {
              guard: "hasExistingTerminal",
              target: "done",
              actions: "setTerminalResult"
            },
            {
              target: "loadingCandidates"
            }
          ]
        }
      },
      loadingCandidates: {
        invoke: {
          src: "loadCandidates",
          input: () => input,
          onDone: [
            {
              guard: "hasLoadedTerminal",
              target: "done",
              actions: "setTerminalResult"
            },
            {
              guard: "hasCandidateList",
              target: "tryingCandidate",
              actions: "setCandidates"
            },
            {
              target: "exhausted"
            }
          ]
        }
      },
      tryingCandidate: {
        invoke: {
          src: "tryCandidate",
          input: ({ context }) => ({
            ...input,
            candidate: context.candidates[context.currentIndex] as TCandidate,
            attemptNumber: context.attemptedFetches + 1
          }),
          onDone: [
            {
              guard: "candidateGrabbed",
              target: "done",
              actions: "setTerminalResult"
            },
            {
              guard: "retryableFailure",
              target: "done",
              actions: ["recordFailure", "setTerminalResult"]
            },
            {
              guard: "shouldStop",
              target: "exhausted",
              actions: "recordFailure"
            },
            {
              target: "tryingCandidate",
              actions: "recordFailure"
            }
          ]
        }
      },
      exhausted: {
        invoke: {
          src: "buildExhaustedResult",
          input: ({ context }) => ({
            handlers: input.handlers,
            rejected: context.rejected,
            attemptedFetches: context.attemptedFetches,
            candidates: context.candidates
          }),
          onDone: {
            target: "done",
            actions: "setTerminalResult"
          }
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
    return actor.getSnapshot().context.result as RequestPipelineResult;
  } finally {
    actor.stop();
  }
}
