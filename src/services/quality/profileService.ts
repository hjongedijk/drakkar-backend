import type { Prisma } from "../../repositories/db/prisma.js";
import { prisma } from "../../repositories/db/prisma.js";
import type { Release } from "../releases/types.js";
import { profileTemplates } from "./templates.js";
import { scoreRelease } from "./scoring.js";

const legacyBuiltinProfileNames = new Set([
  "Any",
  "Remux Preferred",
  "WEB-DL Preferred",
  "Small Size",
  "Anime"
]);

export async function ensureDefaultProfiles() {
  for (const template of profileTemplates) {
    await prisma.qualityProfile.upsert({
      where: { name: template.name },
      update: template,
      create: template
    });
  }
}

export async function listProfiles() {
  await ensureDefaultProfiles();
  const profiles = await prisma.qualityProfile.findMany({ orderBy: { name: "asc" } });
  const [requestRows, providerRows, libraryRows] = await Promise.all([
    prisma.mediaRequest.findMany({ where: { selectedProfileId: { not: null } }, select: { selectedProfileId: true } }),
    prisma.requestProvider.findMany({ select: { defaultMovieProfile: true, defaultTvProfile: true } }),
    prisma.mediaLibraryItem.findMany({ where: { qualityProfileId: { not: null } }, select: { qualityProfileId: true } })
  ]);
  const activeProfileIds = new Set<string>();
  for (const row of requestRows) if (row.selectedProfileId) activeProfileIds.add(row.selectedProfileId);
  for (const row of libraryRows) if (row.qualityProfileId) activeProfileIds.add(row.qualityProfileId);
  const activeProfileNames = new Set(
    providerRows.flatMap((row) => [row.defaultMovieProfile, row.defaultTvProfile]).filter((value): value is string => Boolean(value))
  );
  return profiles.filter((profile) => !legacyBuiltinProfileNames.has(profile.name) || activeProfileIds.has(profile.id) || activeProfileNames.has(profile.name));
}

export async function createProfile(data: Prisma.QualityProfileCreateInput) {
  return prisma.qualityProfile.create({ data });
}

export async function getProfile(id: string) {
  return prisma.qualityProfile.findUniqueOrThrow({ where: { id }, include: { rules: true } });
}

export async function updateProfile(id: string, data: Prisma.QualityProfileUpdateInput) {
  return prisma.qualityProfile.update({ where: { id }, data });
}

export async function deleteProfile(id: string) {
  return prisma.qualityProfile.delete({ where: { id } });
}

export async function scoreAndStoreRelease(profileId: string, release: Release) {
  const profile = await prisma.qualityProfile.findUniqueOrThrow({ where: { id: profileId } });
  const decision = scoreRelease(release, profile);
  await prisma.releaseDecision.create({
    data: {
      profileId,
      releaseTitle: release.title,
      releaseGuid: release.guid,
      accepted: decision.accepted,
      score: decision.score,
      reasons: decision.reasons,
      parsed: decision.parsed
    }
  });
  return decision;
}
