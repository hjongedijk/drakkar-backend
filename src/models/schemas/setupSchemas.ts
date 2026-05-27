import { z } from "zod";

export const completeSetupSchema = z.object({
  admin: z.object({
    username: z.string().trim().min(1),
    displayName: z.string().trim().optional(),
    password: z.string().min(8)
  }).optional(),
  settings: z.object({
    nzbhydraUrl: z.string().trim().optional(),
    nzbhydraApiKey: z.string().trim().optional(),
    tmdbApiKey: z.string().trim().optional(),
    tvdbApiKey: z.string().trim().optional(),
    plexServerUrl: z.string().trim().optional(),
    plexToken: z.string().trim().optional(),
    plexLibraryPath: z.string().trim().optional(),
    plexSectionId: z.string().trim().optional()
  }).optional(),
  usenet: z.object({
    name: z.string().trim().min(1),
    host: z.string().trim().min(1),
    port: z.number().int().positive().default(563),
    ssl: z.boolean().default(true),
    username: z.string().trim().optional(),
    password: z.string().trim().optional(),
    connections: z.number().int().positive().default(10),
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
    isBackup: z.boolean().default(false)
  }).optional(),
  requestProvider: z.object({
    name: z.string().trim().min(1),
    baseUrl: z.string().trim().min(1),
    apiKey: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    syncIntervalMinutes: z.number().int().positive().default(15),
    defaultMovieProfile: z.string().trim().optional(),
    defaultTvProfile: z.string().trim().optional()
  }).optional()
});
