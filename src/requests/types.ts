export type RequestProviderType = "seerr";

export type ExternalMediaRequest = {
  externalId: string;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  seasons?: unknown;
  episodes?: unknown;
  requestedBy?: string;
  requestedQuality?: string;
  externalStatus?: string;
};
