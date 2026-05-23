const qualityMarkers = [
  "2160p",
  "1080p",
  "720p",
  "480p",
  "web-dl",
  "webdl",
  "webrip",
  "bluray",
  "blu-ray",
  "hdtv",
  "remux",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "av1",
  "hdr",
  "dv"
];

function cleanTitle(value: string) {
  return value
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+-\s+[A-Za-z0-9]+$/, "")
    .trim();
}

function trimAtQuality(value: string) {
  const pattern = new RegExp(`\\b(${qualityMarkers.join("|")})\\b.*$`, "i");
  return value.replace(pattern, "").trim();
}

export function normalizeTitleForIdentity(value: string) {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mediaIdentityKey(input: {
  mediaType: string;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  imdbId?: string | null;
}) {
  if (input.imdbId) return `${input.mediaType}:imdb:${input.imdbId}:s${input.season ?? ""}:e${input.episode ?? ""}`;
  if (input.tmdbId) return `${input.mediaType}:tmdb:${input.tmdbId}:s${input.season ?? ""}:e${input.episode ?? ""}`;
  if (input.tvdbId) return `${input.mediaType}:tvdb:${input.tvdbId}:s${input.season ?? ""}:e${input.episode ?? ""}`;
  return [
    input.mediaType,
    normalizeTitleForIdentity(input.title),
    input.year ?? "",
    input.season ?? "",
    input.episode ?? ""
  ].join(":");
}

export function inferMediaIdentity(rawTitle: string) {
  const normalized = cleanTitle(rawTitle);
  const episode = normalized.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (episode) {
    return {
      mediaType: "tv",
      title: trimAtQuality(normalized.slice(0, episode.index)).trim() || normalized,
      season: Number(episode[1]),
      episode: Number(episode[2])
    };
  }

  const alternateEpisode = normalized.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (alternateEpisode) {
    return {
      mediaType: "tv",
      title: trimAtQuality(normalized.slice(0, alternateEpisode.index)).trim() || normalized,
      season: Number(alternateEpisode[1]),
      episode: Number(alternateEpisode[2])
    };
  }

  const seasonPack = normalized.match(/\bS(\d{1,2})(?!\s*E\d{1,3})\b/i);
  if (seasonPack) {
    return {
      mediaType: "tv",
      title: trimAtQuality(normalized.slice(0, seasonPack.index)).trim() || normalized,
      season: Number(seasonPack[1])
    };
  }

  const dailyEpisode = normalized.match(/\b(19\d{2}|20\d{2})[ .-](0[1-9]|1[0-2])[ .-](0[1-9]|[12]\d|3[01])\b/);
  if (dailyEpisode) {
    return {
      mediaType: "tv",
      title: trimAtQuality(normalized.slice(0, dailyEpisode.index)).trim() || normalized,
      year: Number(dailyEpisode[1])
    };
  }

  const year = normalized.match(/\b(19\d{2}|20\d{2})\b/);
  if (year?.index != null) {
    return {
      mediaType: "movie",
      title: trimAtQuality(normalized.slice(0, year.index)).trim() || normalized,
      year: Number(year[1])
    };
  }

  return {
    mediaType: "unknown",
    title: trimAtQuality(normalized) || normalized
  };
}
