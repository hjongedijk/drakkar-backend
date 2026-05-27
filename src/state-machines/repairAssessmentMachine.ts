import { assign, createActor, fromPromise, setup, waitFor } from "xstate";

type RepairAssessmentResult = {
  status: "completed" | "needs_attention";
  message: string;
};

type RepairAssessmentHandlers<TJob, TFile> = {
  createJob: () => Promise<TJob>;
  listFiles: () => Promise<TFile[]>;
  pickVideos: (files: TFile[]) => TFile[];
  probeVideo: (video: TFile) => Promise<number>;
  finalize: (job: TJob, result: RepairAssessmentResult) => Promise<unknown>;
};

type RepairAssessmentInput<TJob, TFile> = {
  handlers: RepairAssessmentHandlers<TJob, TFile>;
};

type RepairAssessmentContext<TJob, TFile> = {
  job: TJob | null;
  files: TFile[];
  videos: TFile[];
  probedBytes: number;
  result: RepairAssessmentResult | null;
};

function getEventOutput<T>(event: unknown): T | null {
  if (!event || typeof event !== "object" || !("output" in event)) return null;
  return (event as { output: T }).output;
}

function getEventErrorMessage(event: unknown) {
  if (event instanceof Error) return event.message;
  if (event && typeof event === "object" && "error" in event) {
    const nested = (event as { error?: unknown }).error;
    if (nested instanceof Error) return nested.message;
    if (typeof nested === "string") return nested;
    if (nested && typeof nested === "object" && "message" in nested && typeof (nested as { message?: unknown }).message === "string") {
      return (nested as { message: string }).message;
    }
  }
  return "mounted healthcheck failed";
}

export async function runRepairAssessmentMachine<TJob, TFile>(input: RepairAssessmentInput<TJob, TFile>) {
  const machine = setup({
    types: {
      context: {} as RepairAssessmentContext<TJob, TFile>,
      input: {} as RepairAssessmentInput<TJob, TFile>,
      events: {} as { type: "noop" }
    },
    actors: {
      createJob: fromPromise(async () => input.handlers.createJob()),
      listFiles: fromPromise(async () => input.handlers.listFiles()),
      probeVideo: fromPromise(async ({ input: actorInput }: { input: { video: TFile } }) => input.handlers.probeVideo(actorInput.video)),
      persistResult: fromPromise(async ({ input: actorInput }: { input: { job: TJob; result: RepairAssessmentResult } }) =>
        input.handlers.finalize(actorInput.job, actorInput.result))
    },
    actions: {
      setJob: assign(({ event }) => ({ job: getEventOutput<TJob>(event) })),
      setFilesAndVideos: assign(({ event }) => {
        const files = getEventOutput<TFile[]>(event) ?? [];
        return { files, videos: input.handlers.pickVideos(files) };
      }),
      setProbedBytes: assign(({ event }) => ({ probedBytes: getEventOutput<number>(event) ?? 0 })),
      setSuccessResult: assign(({ context }) => ({
        result: context.videos.length > 0 && context.probedBytes > 0
          ? {
              status: "completed" as const,
              message: `mounted healthcheck passed: ${context.videos.length} playable video file(s); probed ${context.probedBytes} bytes`
            }
          : {
              status: "needs_attention" as const,
              message: context.videos.length > 0
                ? "mounted healthcheck failed: could not probe stream bytes from mounted video"
                : "mounted healthcheck failed: no playable video files found"
            }
      })),
      setFailureResult: assign(({ event }) => ({
        result: {
          status: "needs_attention" as const,
          message: getEventErrorMessage(event)
        }
      }))
    }
  }).createMachine({
    id: "repairAssessment",
    initial: "creatingJob",
    context: {
      job: null,
      files: [],
      videos: [],
      probedBytes: 0,
      result: null
    },
    states: {
      creatingJob: {
        invoke: {
          src: "createJob",
          onDone: { target: "listingFiles", actions: "setJob" },
          onError: { target: "failed", actions: "setFailureResult" }
        }
      },
      listingFiles: {
        invoke: {
          src: "listFiles",
          onDone: [
            { target: "doneNoVideos", guard: ({ event }) => (getEventOutput<TFile[]>(event) ?? []).length === 0, actions: "setFilesAndVideos" },
            { target: "probing", actions: "setFilesAndVideos" }
          ],
          onError: { target: "failed", actions: "setFailureResult" }
        }
      },
      doneNoVideos: {
        entry: "setSuccessResult",
        always: "persisting"
      },
      probing: {
        always: [
          { target: "doneNoVideos", guard: ({ context }) => context.videos.length === 0 },
          { target: "probingVideo" }
        ]
      },
      probingVideo: {
        invoke: {
          src: "probeVideo",
          input: ({ context }) => ({ video: context.videos[0] as TFile }),
          onDone: { target: "probed", actions: "setProbedBytes" },
          onError: { target: "failed", actions: "setFailureResult" }
        }
      },
      probed: {
        entry: "setSuccessResult",
        always: "persisting"
      },
      persisting: {
        invoke: {
          src: "persistResult",
          input: ({ context }) => ({ job: context.job as TJob, result: context.result as RepairAssessmentResult }),
          onDone: { target: "done" },
          onError: { target: "failed", actions: "setFailureResult" }
        }
      },
      failed: {
        always: "persistingFailure"
      },
      persistingFailure: {
        invoke: {
          src: "persistResult",
          input: ({ context }) => ({ job: context.job as TJob, result: context.result as RepairAssessmentResult }),
          onDone: { target: "done" },
          onError: { target: "done" }
        }
      },
      done: { type: "final" }
    }
  });

  const actor = createActor(machine, { input });
  try {
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === "done");
    return actor.getSnapshot().context.result;
  } finally {
    actor.stop();
  }
}
