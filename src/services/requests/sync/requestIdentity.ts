import type { MediaRequest } from "../../../repositories/db/prisma.js";
import { normalizeTitleForIdentity } from "../../media-library/identity.js";
import type { ExternalMediaRequest } from "../types.js";

type RequestIdentityLike = Pick<
  MediaRequest,
  "mediaType" | "title" | "year" | "tmdbId" | "tvdbId" | "imdbId" | "downloadId" | "status" | "selectedRelease" | "requestedQuality" | "createdAt"
> & {
  imports?: { id: string }[];
};

function hasIdentityIds(input: { tmdbId?: string | null; tvdbId?: string | null; imdbId?: string | null }) {
  return Boolean(input.imdbId || input.tmdbId || input.tvdbId);
}

export function requestMatchesIdentity(existing: RequestIdentityLike, incoming: ExternalMediaRequest | RequestIdentityLike) {
  if (existing.mediaType !== incoming.mediaType) return false;

  const hasIdMatch = Boolean(
    (incoming.imdbId && existing.imdbId === incoming.imdbId) ||
    (incoming.tmdbId && existing.tmdbId === incoming.tmdbId) ||
    (incoming.tvdbId && existing.tvdbId === incoming.tvdbId)
  );

  if (hasIdMatch) {
    if (incoming.year && existing.year && incoming.year !== existing.year) return false;
    return true;
  }

  if (hasIdentityIds(existing) || hasIdentityIds(incoming)) return false;
  if (!incoming.year || !existing.year || incoming.year !== existing.year) return false;
  return normalizeTitleForIdentity(existing.title) === normalizeTitleForIdentity(incoming.title);
}

export function requestDuplicateRank(candidate: RequestIdentityLike) {
  let score = 0;
  if (candidate.downloadId) score += 100;
  if ((candidate.imports?.length ?? 0) > 0) score += 80;
  if (candidate.status === "available") score += 60;
  else if (candidate.status === "grabbed") score += 40;
  if (candidate.selectedRelease) score += 25;
  if (candidate.requestedQuality) score += 10;
  return score;
}
