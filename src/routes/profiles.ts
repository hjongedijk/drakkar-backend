import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Release } from "../releases/types.js";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  scoreAndStoreRelease,
  updateProfile
} from "../quality/profileService.js";
import { scoreRelease } from "../quality/scoring.js";

const profileSchema = z.object({
  name: z.string().min(1),
  allowedQualities: z.array(z.string()).default([]),
  cutoffQuality: z.string().nullable().optional(),
  preferredWords: z.array(z.string()).default([]),
  rejectedWords: z.array(z.string()).default([]),
  requiredWords: z.array(z.string()).default([]),
  minSize: z.number().nullable().optional(),
  maxSize: z.number().nullable().optional(),
  preferredLanguages: z.array(z.string()).default([]),
  requiredLanguages: z.array(z.string()).default([]),
  allowHDR: z.boolean().default(true),
  allowDV: z.boolean().default(true),
  allowRemux: z.boolean().default(true),
  allowBluRay: z.boolean().default(true),
  allowWebDL: z.boolean().default(true),
  allowWebRip: z.boolean().default(true),
  allowX264: z.boolean().default(true),
  allowX265: z.boolean().default(true),
  allowAV1: z.boolean().default(true),
  allowMultiAudio: z.boolean().default(true),
  rejectCam: z.boolean().default(true),
  rejectTelesync: z.boolean().default(true),
  rejectScreener: z.boolean().default(true),
  rejectPassworded: z.boolean().default(true),
  rejectSuspicious: z.boolean().default(true),
  preferProper: z.boolean().default(true),
  preferRepack: z.boolean().default(true)
});

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/profiles", async () => listProfiles());
  app.post("/api/profiles", async (request) => createProfile(profileSchema.parse(request.body)));
  app.get("/api/profiles/:id", async (request) => getProfile((request.params as { id: string }).id));
  app.put("/api/profiles/:id", async (request) => updateProfile((request.params as { id: string }).id, profileSchema.partial().parse(request.body)));
  app.delete("/api/profiles/:id", async (request) => deleteProfile((request.params as { id: string }).id));

  app.post("/api/profiles/:id/test", async (request) => {
    const profile = await getProfile((request.params as { id: string }).id);
    return scoreRelease((request.body as { release: Release }).release, profile);
  });

  app.post("/api/releases/score", async (request) => {
    const body = z.object({ profileId: z.string(), release: z.any() }).parse(request.body);
    return scoreAndStoreRelease(body.profileId, body.release);
  });
}
