ALTER TABLE "MediaLibraryItem"
  DROP COLUMN IF EXISTS "posterUrl",
  DROP COLUMN IF EXISTS "backdropUrl",
  DROP COLUMN IF EXISTS "overview",
  DROP COLUMN IF EXISTS "metadataProvider",
  DROP COLUMN IF EXISTS "metadataUpdatedAt",
  DROP COLUMN IF EXISTS "episodeTitle",
  DROP COLUMN IF EXISTS "episodeOverview",
  DROP COLUMN IF EXISTS "episodeAirDate";
