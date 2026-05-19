import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import type { Release } from "../releases/types.js";
import { profileTemplates } from "./templates.js";
import { scoreRelease } from "./scoring.js";

export async function ensureDefaultProfiles() {
  for (const template of profileTemplates) {
    await prisma.qualityProfile.upsert({
      where: { name: template.name },
      update: {},
      create: template
    });
  }
}

export async function listProfiles() {
  await ensureDefaultProfiles();
  return prisma.qualityProfile.findMany({ orderBy: { name: "asc" } });
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
