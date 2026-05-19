ALTER TABLE "MediaLibraryItem"
  ADD COLUMN "posterUrl" TEXT,
  ADD COLUMN "backdropUrl" TEXT,
  ADD COLUMN "overview" TEXT,
  ADD COLUMN "metadataProvider" TEXT,
  ADD COLUMN "metadataUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "episodeOverview" TEXT,
  ADD COLUMN "episodeAirDate" TIMESTAMP(3);
