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

function stripWrappedYear(value: string) {
  return value.replace(/\s*\((19|20)\d{2}\)\s*$/g, "").trim();
}

export function canonicalizeDisplayTitle(value: string, year?: number | null) {
  const normalized = stripWrappedYear(cleanTitle(value))
    .replace(/\s*[:]\s*/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!year) return normalized;
  return normalized.replace(new RegExp(`\\b${year}\\b$`), "").replace(/\s+/g, " ").trim();
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

function compactNormalizedTitle(value: string) {
  return normalizeTitleForIdentity(value).replace(/\s+/g, "");
}

function normalizedTitleTokens(value: string) {
  return normalizeTitleForIdentity(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

export function titlesLikelyMatch(left: string, right: string) {
  const normalizedLeft = normalizeTitleForIdentity(left);
  const normalizedRight = normalizeTitleForIdentity(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const compactLeft = compactNormalizedTitle(left);
  const compactRight = compactNormalizedTitle(right);
  if (!compactLeft || !compactRight) return false;

  const shortCompactLength = Math.min(compactLeft.length, compactRight.length);
  if (shortCompactLength <= 4) return compactLeft === compactRight;

  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    const shorter = Math.min(compactLeft.length, compactRight.length);
    const longer = Math.max(compactLeft.length, compactRight.length);
    if (shorter / longer >= 0.8) return true;
  }

  const leftTokens = new Set(normalizedTitleTokens(left));
  const rightTokens = new Set(normalizedTitleTokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;

  const numericLeft = [...leftTokens].filter((token) => /^\d+$/.test(token));
  if (numericLeft.some((token) => !rightTokens.has(token))) return false;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const leftOverlapRatio = overlap / leftTokens.size;
  const rightOverlapRatio = overlap / rightTokens.size;
  return leftOverlapRatio >= 0.75 && rightOverlapRatio >= 0.75;
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

export function importIdentityKey(input: {
  mediaType: string;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}) {
  return mediaIdentityKey({
    mediaType: input.mediaType,
    title: input.title,
    year: input.year,
    season: input.season,
    episode: input.episode
  });
}

export function inferMediaIdentity(rawTitle: string) {
  const normalized = cleanTitle(rawTitle);
  const multiEpisode = normalized.match(/\bS(\d{1,2})E(\d{1,4})(?:E(\d{1,4})|[- .]E?(\d{1,4}))\b/i);
  if (multiEpisode) {
    return {
      mediaType: "tv",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, multiEpisode.index)).trim() || normalized),
      season: Number(multiEpisode[1]),
      episode: Number(multiEpisode[2])
    };
  }

  const episode = normalized.match(/\bS(\d{1,2})E(\d{1,4})\b/i);
  const wideSeasonEpisode = normalized.match(/\bS(\d{1,3})E(\d{1,4})\b/i);
  if (wideSeasonEpisode) {
    return {
      mediaType: "tv",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, wideSeasonEpisode.index)).trim() || normalized),
      season: Number(wideSeasonEpisode[1]),
      episode: Number(wideSeasonEpisode[2])
    };
  }

  const animeEpisode = normalized.match(/\bEP?(\d{2,4})\b/i);
  if (animeEpisode) {
    return {
      mediaType: "tv",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, animeEpisode.index)).trim() || normalized),
      episode: Number(animeEpisode[1])
    };
  }

  if (episode) {
    return {
      mediaType: "tv",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, episode.index)).trim() || normalized),
      season: Number(episode[1]),
      episode: Number(episode[2])
    };
  }

  const alternateEpisode = normalized.match(/\b(\d{1,2})x(\d{1,4})\b/i);
  if (alternateEpisode) {
    return {
      mediaType: "tv",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, alternateEpisode.index)).trim() || normalized),
      season: Number(alternateEpisode[1]),
      episode: Number(alternateEpisode[2])
    };
  }

  const seasonPack = normalized.match(/\bS(\d{1,3})(?!\s*E\d{1,4})\b/i);
  if (seasonPack) {
    return {
      mediaType: "tv",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, seasonPack.index)).trim() || normalized),
      season: Number(seasonPack[1])
    };
  }

  const dailyEpisode = normalized.match(/\b(19\d{2}|20\d{2})[ .-](0[1-9]|1[0-2])[ .-](0[1-9]|[12]\d|3[01])\b/);
  if (dailyEpisode) {
    return {
      mediaType: "tv",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, dailyEpisode.index)).trim() || normalized),
      year: Number(dailyEpisode[1])
    };
  }

  const year = normalized.match(/\b(19\d{2}|20\d{2})\b/);
  if (year?.index != null) {
    return {
      mediaType: "movie",
      title: canonicalizeDisplayTitle(trimAtQuality(normalized.slice(0, year.index)).trim() || normalized, Number(year[1])),
      year: Number(year[1])
    };
  }

  return {
    mediaType: "unknown",
    title: canonicalizeDisplayTitle(trimAtQuality(normalized) || normalized)
  };
}
