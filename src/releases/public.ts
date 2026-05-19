import type { Release } from "./types.js";

export function toPublicRelease(release: Release): Release {
  if (!release.downloadUrl) return release;
  try {
    const url = new URL(release.downloadUrl);
    url.searchParams.delete("apikey");
    return { ...release, downloadUrl: url.toString() };
  } catch {
    return release;
  }
}

export function toPublicReleases(releases: Release[]) {
  return releases.map(toPublicRelease);
}
