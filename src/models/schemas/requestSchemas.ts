import { z } from "zod";

export const providerSchema = z.object({
  type: z.literal("seerr").default("seerr"),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  enabled: z.boolean().default(true),
  syncIntervalMinutes: z.number().int().positive().default(15),
  defaultMovieProfile: z.string().optional(),
  defaultTvProfile: z.string().optional()
});

export const releaseGrabSchema = z.object({
  release: z.any()
});

export const manualRequestSchema = z.object({
  mediaType: z.enum(["movie", "tv"]),
  title: z.string().min(1),
  year: z.number().int().positive().optional(),
  tmdbId: z.string().optional(),
  tvdbId: z.string().optional(),
  imdbId: z.string().optional()
});

export const syncRequestsSchema = z.object({
  providerId: z.string().optional(),
  full: z.boolean().optional()
});

export const requestProfileSchema = z.object({
  profileId: z.string().min(1)
});

export const episodeParamsSchema = z.object({
  id: z.string(),
  season: z.coerce.number().int().positive(),
  episode: z.coerce.number().int().positive()
});
