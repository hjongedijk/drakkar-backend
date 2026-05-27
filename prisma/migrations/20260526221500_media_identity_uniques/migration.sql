ALTER TABLE "ImportItem" ADD COLUMN "identityKey" TEXT;

UPDATE "ImportItem"
SET "identityKey" = (
  "mediaType" || ':' ||
  btrim(regexp_replace(regexp_replace(lower(coalesce(title, '')), '[''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')) || ':' ||
  coalesce(year::text, '') || ':' ||
  coalesce(season::text, '') || ':' ||
  coalesce(episode::text, '')
);

WITH ranked AS (
  SELECT
    i.id,
    first_value(i.id) OVER (
      PARTITION BY i."identityKey"
      ORDER BY
        CASE WHEN EXISTS (SELECT 1 FROM "Symlink" s WHERE s."importId" = i.id AND s.status <> 'broken') THEN 1 ELSE 0 END DESC,
        CASE WHEN i."requestId" IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN i."completedPath" NOT LIKE '/mounted/%' THEN 1 ELSE 0 END DESC,
        i."updatedAt" DESC,
        i."createdAt" DESC,
        i.id DESC
    ) AS winner_id,
    row_number() OVER (
      PARTITION BY i."identityKey"
      ORDER BY
        CASE WHEN EXISTS (SELECT 1 FROM "Symlink" s WHERE s."importId" = i.id AND s.status <> 'broken') THEN 1 ELSE 0 END DESC,
        CASE WHEN i."requestId" IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN i."completedPath" NOT LIKE '/mounted/%' THEN 1 ELSE 0 END DESC,
        i."updatedAt" DESC,
        i."createdAt" DESC,
        i.id DESC
    ) AS rn
  FROM "ImportItem" i
),
losers AS (
  SELECT id, winner_id
  FROM ranked
  WHERE rn > 1
),
winner_enrichment AS (
  SELECT
    l.winner_id,
    max(i."requestId") AS request_id,
    max(i."downloadId") AS download_id,
    max(i."metadataPath") AS metadata_path,
    max(i."stableIdPath") AS stable_id_path
  FROM losers l
  JOIN "ImportItem" i ON i.id = l.id
  GROUP BY l.winner_id
)
UPDATE "ImportItem" keep
SET
  "requestId" = coalesce(keep."requestId", winner_enrichment.request_id),
  "downloadId" = coalesce(keep."downloadId", winner_enrichment.download_id),
  "metadataPath" = coalesce(keep."metadataPath", winner_enrichment.metadata_path),
  "stableIdPath" = coalesce(keep."stableIdPath", winner_enrichment.stable_id_path)
FROM winner_enrichment
WHERE keep.id = winner_enrichment.winner_id;

WITH ranked AS (
  SELECT
    i.id,
    first_value(i.id) OVER (
      PARTITION BY i."identityKey"
      ORDER BY
        CASE WHEN EXISTS (SELECT 1 FROM "Symlink" s WHERE s."importId" = i.id AND s.status <> 'broken') THEN 1 ELSE 0 END DESC,
        CASE WHEN i."requestId" IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN i."completedPath" NOT LIKE '/mounted/%' THEN 1 ELSE 0 END DESC,
        i."updatedAt" DESC,
        i."createdAt" DESC,
        i.id DESC
    ) AS winner_id,
    row_number() OVER (
      PARTITION BY i."identityKey"
      ORDER BY
        CASE WHEN EXISTS (SELECT 1 FROM "Symlink" s WHERE s."importId" = i.id AND s.status <> 'broken') THEN 1 ELSE 0 END DESC,
        CASE WHEN i."requestId" IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN i."completedPath" NOT LIKE '/mounted/%' THEN 1 ELSE 0 END DESC,
        i."updatedAt" DESC,
        i."createdAt" DESC,
        i.id DESC
    ) AS rn
  FROM "ImportItem" i
),
losers AS (
  SELECT id, winner_id
  FROM ranked
  WHERE rn > 1
)
UPDATE "Symlink" s
SET "importId" = losers.winner_id
FROM losers
WHERE s."importId" = losers.id;

WITH ranked AS (
  SELECT
    i.id,
    row_number() OVER (
      PARTITION BY i."identityKey"
      ORDER BY
        CASE WHEN EXISTS (SELECT 1 FROM "Symlink" s WHERE s."importId" = i.id AND s.status <> 'broken') THEN 1 ELSE 0 END DESC,
        CASE WHEN i."requestId" IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN i."completedPath" NOT LIKE '/mounted/%' THEN 1 ELSE 0 END DESC,
        i."updatedAt" DESC,
        i."createdAt" DESC,
        i.id DESC
    ) AS rn
  FROM "ImportItem" i
),
losers AS (
  SELECT id
  FROM ranked
  WHERE rn > 1
)
DELETE FROM "MediaLibraryItem"
WHERE "sourceKey" IN (SELECT 'import:' || id FROM losers);

WITH ranked AS (
  SELECT
    i.id,
    row_number() OVER (
      PARTITION BY i."identityKey"
      ORDER BY
        CASE WHEN EXISTS (SELECT 1 FROM "Symlink" s WHERE s."importId" = i.id AND s.status <> 'broken') THEN 1 ELSE 0 END DESC,
        CASE WHEN i."requestId" IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN i."completedPath" NOT LIKE '/mounted/%' THEN 1 ELSE 0 END DESC,
        i."updatedAt" DESC,
        i."createdAt" DESC,
        i.id DESC
    ) AS rn
  FROM "ImportItem" i
),
losers AS (
  SELECT id
  FROM ranked
  WHERE rn > 1
)
DELETE FROM "ImportItem"
WHERE id IN (SELECT id FROM losers);

ALTER TABLE "ImportItem" ALTER COLUMN "identityKey" SET NOT NULL;
CREATE UNIQUE INDEX "ImportItem_identityKey_key" ON "ImportItem"("identityKey");

ALTER TABLE "MediaLibraryItem" ADD COLUMN "identityKey" TEXT;

UPDATE "MediaLibraryItem"
SET "identityKey" = (
  CASE
    WHEN coalesce("imdbId", '') <> '' THEN "mediaType" || ':imdb:' || "imdbId" || ':s' || coalesce(season::text, '') || ':e' || coalesce(episode::text, '')
    WHEN coalesce("tmdbId", '') <> '' THEN "mediaType" || ':tmdb:' || "tmdbId" || ':s' || coalesce(season::text, '') || ':e' || coalesce(episode::text, '')
    WHEN coalesce("tvdbId", '') <> '' THEN "mediaType" || ':tvdb:' || "tvdbId" || ':s' || coalesce(season::text, '') || ':e' || coalesce(episode::text, '')
    ELSE
      "mediaType" || ':' ||
      btrim(regexp_replace(regexp_replace(lower(coalesce(title, '')), '[''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')) || ':' ||
      coalesce(year::text, '') || ':' ||
      coalesce(season::text, '') || ':' ||
      coalesce(episode::text, '')
  END
);

WITH ranked AS (
  SELECT
    m.id,
    first_value(m.id) OVER (
      PARTITION BY m."identityKey"
      ORDER BY
        (
          CASE m."libraryStatus"
            WHEN 'available' THEN 400
            WHEN 'grabbed' THEN 300
            WHEN 'searching' THEN 200
            WHEN 'requested' THEN 100
            ELSE 0
          END
          + CASE WHEN m."sourceKey" LIKE 'import:%' THEN 40 ELSE 0 END
          + CASE WHEN coalesce(m."filePath", '') <> '' THEN 20 ELSE 0 END
          + CASE WHEN m."requestId" IS NOT NULL THEN 10 ELSE 0 END
        ) DESC,
        m."updatedAt" DESC,
        m."createdAt" DESC,
        m.id DESC
    ) AS winner_id,
    row_number() OVER (
      PARTITION BY m."identityKey"
      ORDER BY
        (
          CASE m."libraryStatus"
            WHEN 'available' THEN 400
            WHEN 'grabbed' THEN 300
            WHEN 'searching' THEN 200
            WHEN 'requested' THEN 100
            ELSE 0
          END
          + CASE WHEN m."sourceKey" LIKE 'import:%' THEN 40 ELSE 0 END
          + CASE WHEN coalesce(m."filePath", '') <> '' THEN 20 ELSE 0 END
          + CASE WHEN m."requestId" IS NOT NULL THEN 10 ELSE 0 END
        ) DESC,
        m."updatedAt" DESC,
        m."createdAt" DESC,
        m.id DESC
    ) AS rn
  FROM "MediaLibraryItem" m
),
losers AS (
  SELECT id, winner_id
  FROM ranked
  WHERE rn > 1
),
winner_enrichment AS (
  SELECT
    l.winner_id,
    max(m."requestId") AS request_id,
    max(m."downloadId") AS download_id,
    max(m."tmdbId") AS tmdb_id,
    max(m."tvdbId") AS tvdb_id,
    max(m."imdbId") AS imdb_id,
    max(m."posterUrl") AS poster_url,
    max(m."backdropUrl") AS backdrop_url,
    max(m.overview) AS overview,
    max(m."filePath") AS file_path,
    max(m."symlinkPath") AS symlink_path,
    max(m."strmPath") AS strm_path
  FROM losers l
  JOIN "MediaLibraryItem" m ON m.id = l.id
  GROUP BY l.winner_id
)
UPDATE "MediaLibraryItem" keep
SET
  "requestId" = coalesce(keep."requestId", winner_enrichment.request_id),
  "downloadId" = coalesce(keep."downloadId", winner_enrichment.download_id),
  "tmdbId" = coalesce(keep."tmdbId", winner_enrichment.tmdb_id),
  "tvdbId" = coalesce(keep."tvdbId", winner_enrichment.tvdb_id),
  "imdbId" = coalesce(keep."imdbId", winner_enrichment.imdb_id),
  "posterUrl" = coalesce(keep."posterUrl", winner_enrichment.poster_url),
  "backdropUrl" = coalesce(keep."backdropUrl", winner_enrichment.backdrop_url),
  overview = coalesce(keep.overview, winner_enrichment.overview),
  "filePath" = coalesce(keep."filePath", winner_enrichment.file_path),
  "symlinkPath" = coalesce(keep."symlinkPath", winner_enrichment.symlink_path),
  "strmPath" = coalesce(keep."strmPath", winner_enrichment.strm_path)
FROM winner_enrichment
WHERE keep.id = winner_enrichment.winner_id;

WITH ranked AS (
  SELECT
    m.id,
    row_number() OVER (
      PARTITION BY m."identityKey"
      ORDER BY
        (
          CASE m."libraryStatus"
            WHEN 'available' THEN 400
            WHEN 'grabbed' THEN 300
            WHEN 'searching' THEN 200
            WHEN 'requested' THEN 100
            ELSE 0
          END
          + CASE WHEN m."sourceKey" LIKE 'import:%' THEN 40 ELSE 0 END
          + CASE WHEN coalesce(m."filePath", '') <> '' THEN 20 ELSE 0 END
          + CASE WHEN m."requestId" IS NOT NULL THEN 10 ELSE 0 END
        ) DESC,
        m."updatedAt" DESC,
        m."createdAt" DESC,
        m.id DESC
    ) AS rn
  FROM "MediaLibraryItem" m
),
losers AS (
  SELECT id
  FROM ranked
  WHERE rn > 1
)
DELETE FROM "MediaLibraryItem"
WHERE id IN (SELECT id FROM losers);

ALTER TABLE "MediaLibraryItem" ALTER COLUMN "identityKey" SET NOT NULL;
CREATE UNIQUE INDEX "MediaLibraryItem_identityKey_key" ON "MediaLibraryItem"("identityKey");
