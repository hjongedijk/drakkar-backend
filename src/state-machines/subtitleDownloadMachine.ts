import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import type { AppSettings } from "../services/settings/settingsStore.js";

export type SubtitleLookup = {
  mediaType: "movie" | "tv";
  title: string;
  year?: number | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
};

type SubtitleDownloadResult = {
  downloaded: number;
  skipped: number;
  reason?: "not_configured" | "missing_ids" | "already_present";
};

type SubtitleDownloadHandlers = {
  loadSettings: () => Promise<AppSettings>;
  checkConfig: (settings: AppSettings) => Promise<SubtitleDownloadResult | null>;
  hydrateLookup: (settings: AppSettings, lookup: SubtitleLookup) => Promise<SubtitleLookup | null>;
  processProviders: (settings: AppSettings, lookup: SubtitleLookup) => Promise<SubtitleDownloadResult>;
};

type SubtitleDownloadInput = {
  mediaPath: string;
  lookup: SubtitleLookup;
  settingsOverride?: AppSettings;
  handlers: SubtitleDownloadHandlers;
};

type SubtitleDownloadContext = {
  settings: AppSettings | null;
  lookup: SubtitleLookup | null;
  result: SubtitleDownloadResult | null;
};

function getEventOutput<T>(event: unknown): T | null {
  if (!event || typeof event !== "object" || !("output" in event)) return null;
  return (event as { output: T }).output;
}

export async function runSubtitleDownloadMachine(input: SubtitleDownloadInput) {
  const machine = setup({
    types: {
      context: {} as SubtitleDownloadContext,
      input: {} as SubtitleDownloadInput,
      events: {} as { type: "noop" }
    },
    actors: {
      loadSettings: fromPromise(async () => input.settingsOverride ?? input.handlers.loadSettings()),
      checkConfig: fromPromise(async ({ input: actorInput }: { input: { settings: AppSettings } }) => input.handlers.checkConfig(actorInput.settings)),
      hydrateLookup: fromPromise(async ({ input: actorInput }: { input: { settings: AppSettings } }) => input.handlers.hydrateLookup(actorInput.settings, input.lookup)),
      processProviders: fromPromise(async ({ input: actorInput }: { input: { settings: AppSettings; lookup: SubtitleLookup } }) =>
        input.handlers.processProviders(actorInput.settings, actorInput.lookup))
    },
    actions: {
      setSettings: assign(({ event }) => ({ settings: getEventOutput<AppSettings>(event) })),
      setLookup: assign(({ event }) => ({ lookup: getEventOutput<SubtitleLookup | null>(event) })),
      setResult: assign(({ event }) => ({ result: getEventOutput<SubtitleDownloadResult>(event) }))
    }
  }).createMachine({
    id: "subtitleDownload",
    initial: "loadingSettings",
    context: {
      settings: null,
      lookup: null,
      result: null
    },
    states: {
      loadingSettings: {
        invoke: {
          src: "loadSettings",
          onDone: { target: "checkingConfig", actions: "setSettings" },
          onError: { target: "failed" }
        }
      },
      checkingConfig: {
        invoke: {
          src: "checkConfig",
          input: ({ context }) => ({ settings: context.settings as AppSettings }),
          onDone: [
            {
              guard: ({ event }) => Boolean(getEventOutput<SubtitleDownloadResult | null>(event)),
              target: "done",
              actions: "setResult"
            },
            { target: "hydratingLookup" }
          ],
          onError: { target: "failed" }
        }
      },
      hydratingLookup: {
        invoke: {
          src: "hydrateLookup",
          input: ({ context }) => ({ settings: context.settings as AppSettings }),
          onDone: [
            {
              guard: ({ event }) => !getEventOutput<SubtitleLookup | null>(event),
              target: "done",
              actions: assign({ result: () => ({ downloaded: 0, skipped: 0, reason: "missing_ids" as const }) })
            },
            { target: "processingProviders", actions: "setLookup" }
          ],
          onError: { target: "failed" }
        }
      },
      processingProviders: {
        invoke: {
          src: "processProviders",
          input: ({ context }) => ({ settings: context.settings as AppSettings, lookup: context.lookup as SubtitleLookup }),
          onDone: { target: "done", actions: "setResult" },
          onError: { target: "failed" }
        }
      },
      done: { type: "final" },
      failed: {
        entry: assign({ result: () => ({ downloaded: 0, skipped: 0 }) }),
        type: "final"
      }
    }
  });

  const actor = createActor(machine, { input });
  try {
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === "done");
    return actor.getSnapshot().context.result ?? { downloaded: 0, skipped: 0 };
  } finally {
    actor.stop();
  }
}
