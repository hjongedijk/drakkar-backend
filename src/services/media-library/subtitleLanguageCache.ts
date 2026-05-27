const subtitleLanguageCache = new Map<string, { languages: string[]; expiresAt: number }>();
const SUBTITLE_LANGUAGE_CACHE_MS = 10 * 60 * 1000;

export function getCachedSubtitleLanguages(mediaPath: string) {
  const cached = subtitleLanguageCache.get(mediaPath);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.languages;
}

export function updateSubtitleLanguageCache(mediaPath: string, languages: string[]) {
  subtitleLanguageCache.set(mediaPath, {
    languages: [...new Set(languages.map((language) => language.toUpperCase()))].sort(),
    expiresAt: Date.now() + SUBTITLE_LANGUAGE_CACHE_MS
  });
}

export function invalidateSubtitleLanguageCache(mediaPath: string) {
  subtitleLanguageCache.delete(mediaPath);
}
