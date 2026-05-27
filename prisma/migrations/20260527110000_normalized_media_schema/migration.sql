CREATE TABLE "movies" (
  "id" TEXT NOT NULL,
  "tmdb_id" TEXT NOT NULL,
  "imdb_id" TEXT,
  "tvdb_id" TEXT,
  "title" TEXT NOT NULL,
  "original_title" TEXT,
  "overview" TEXT,
  "release_date" TIMESTAMP(3),
  "year" INTEGER,
  "runtime_minutes" INTEGER,
  "poster_path" TEXT,
  "backdrop_path" TEXT,
  "raw_seerr" JSONB,
  "raw_tmdb" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "movies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tv_shows" (
  "id" TEXT NOT NULL,
  "tmdb_id" TEXT NOT NULL,
  "imdb_id" TEXT,
  "tvdb_id" TEXT,
  "title" TEXT NOT NULL,
  "original_title" TEXT,
  "overview" TEXT,
  "first_air_date" TIMESTAMP(3),
  "last_air_date" TIMESTAMP(3),
  "year" INTEGER,
  "poster_path" TEXT,
  "backdrop_path" TEXT,
  "number_of_seasons" INTEGER,
  "number_of_episodes" INTEGER,
  "raw_seerr" JSONB,
  "raw_tmdb" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tv_shows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tv_seasons" (
  "id" TEXT NOT NULL,
  "tv_show_id" TEXT NOT NULL,
  "tmdb_id" TEXT,
  "tvdb_id" TEXT,
  "season_number" INTEGER NOT NULL,
  "title" TEXT,
  "overview" TEXT,
  "air_date" TIMESTAMP(3),
  "poster_path" TEXT,
  "episode_count" INTEGER,
  "raw_seerr" JSONB,
  "raw_tmdb" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tv_seasons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tv_episodes" (
  "id" TEXT NOT NULL,
  "tv_show_id" TEXT NOT NULL,
  "season_id" TEXT NOT NULL,
  "tmdb_id" TEXT,
  "imdb_id" TEXT,
  "tvdb_id" TEXT,
  "season_number" INTEGER NOT NULL,
  "episode_number" INTEGER NOT NULL,
  "absolute_episode_number" INTEGER,
  "title" TEXT NOT NULL,
  "overview" TEXT,
  "air_date" TIMESTAMP(3),
  "runtime_minutes" INTEGER,
  "still_path" TEXT,
  "raw_seerr" JSONB,
  "raw_tmdb" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tv_episodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "media_files" (
  "id" TEXT NOT NULL,
  "media_type" TEXT NOT NULL,
  "movie_id" TEXT,
  "episode_id" TEXT,
  "import_id" TEXT,
  "download_id" TEXT,
  "nzb_id" TEXT,
  "vfs_mount_id" TEXT,
  "path" TEXT,
  "folder_path" TEXT,
  "file_path" TEXT,
  "symlink_path" TEXT,
  "strm_path" TEXT,
  "filename" TEXT,
  "size" DOUBLE PRECISION,
  "duration" DOUBLE PRECISION,
  "quality" TEXT,
  "source" TEXT,
  "codec" TEXT,
  "audio" TEXT,
  "hdr" BOOLEAN NOT NULL DEFAULT false,
  "dv" BOOLEAN NOT NULL DEFAULT false,
  "release_group" TEXT,
  "is_available" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_files_single_target" CHECK (
    (CASE WHEN "movie_id" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "episode_id" IS NOT NULL THEN 1 ELSE 0 END) = 1
  ),
  CONSTRAINT "media_files_target_matches_type" CHECK (
    ("media_type" = 'movie' AND "movie_id" IS NOT NULL AND "episode_id" IS NULL) OR
    ("media_type" = 'episode' AND "episode_id" IS NOT NULL AND "movie_id" IS NULL)
  )
);

ALTER TABLE "MediaRequest"
  ADD COLUMN "movieId" TEXT,
  ADD COLUMN "tvShowId" TEXT,
  ADD COLUMN "seasonId" TEXT,
  ADD COLUMN "episodeId" TEXT,
  ADD COLUMN "rawRequest" JSONB,
  ADD COLUMN "rawMedia" JSONB;

ALTER TABLE "MediaLibraryItem"
  ADD COLUMN "movieId" TEXT,
  ADD COLUMN "tvShowId" TEXT,
  ADD COLUMN "seasonId" TEXT,
  ADD COLUMN "episodeId" TEXT;

CREATE UNIQUE INDEX "movies_tmdb_id_key" ON "movies"("tmdb_id");
CREATE UNIQUE INDEX "movies_imdb_id_key" ON "movies"("imdb_id") WHERE "imdb_id" IS NOT NULL;
CREATE UNIQUE INDEX "movies_tvdb_id_key" ON "movies"("tvdb_id") WHERE "tvdb_id" IS NOT NULL;
CREATE INDEX "movies_title_idx" ON "movies"("title");
CREATE INDEX "movies_year_idx" ON "movies"("year");

CREATE UNIQUE INDEX "tv_shows_tmdb_id_key" ON "tv_shows"("tmdb_id");
CREATE UNIQUE INDEX "tv_shows_imdb_id_key" ON "tv_shows"("imdb_id") WHERE "imdb_id" IS NOT NULL;
CREATE UNIQUE INDEX "tv_shows_tvdb_id_key" ON "tv_shows"("tvdb_id") WHERE "tvdb_id" IS NOT NULL;
CREATE INDEX "tv_shows_title_idx" ON "tv_shows"("title");
CREATE INDEX "tv_shows_year_idx" ON "tv_shows"("year");

CREATE UNIQUE INDEX "tv_seasons_tv_show_id_season_number_key" ON "tv_seasons"("tv_show_id", "season_number");
CREATE UNIQUE INDEX "tv_seasons_tmdb_id_key" ON "tv_seasons"("tmdb_id") WHERE "tmdb_id" IS NOT NULL;
CREATE UNIQUE INDEX "tv_seasons_tvdb_id_key" ON "tv_seasons"("tvdb_id") WHERE "tvdb_id" IS NOT NULL;
CREATE INDEX "tv_seasons_tv_show_id_idx" ON "tv_seasons"("tv_show_id");
CREATE INDEX "tv_seasons_tv_show_id_season_number_idx" ON "tv_seasons"("tv_show_id", "season_number");

CREATE UNIQUE INDEX "tv_episodes_tv_show_id_season_number_episode_number_key" ON "tv_episodes"("tv_show_id", "season_number", "episode_number");
CREATE UNIQUE INDEX "tv_episodes_season_id_episode_number_key" ON "tv_episodes"("season_id", "episode_number");
CREATE UNIQUE INDEX "tv_episodes_tmdb_id_key" ON "tv_episodes"("tmdb_id") WHERE "tmdb_id" IS NOT NULL;
CREATE UNIQUE INDEX "tv_episodes_imdb_id_key" ON "tv_episodes"("imdb_id") WHERE "imdb_id" IS NOT NULL;
CREATE UNIQUE INDEX "tv_episodes_tvdb_id_key" ON "tv_episodes"("tvdb_id") WHERE "tvdb_id" IS NOT NULL;
CREATE INDEX "tv_episodes_tv_show_id_idx" ON "tv_episodes"("tv_show_id");
CREATE INDEX "tv_episodes_season_id_idx" ON "tv_episodes"("season_id");
CREATE INDEX "tv_episodes_tv_show_id_season_number_episode_number_idx" ON "tv_episodes"("tv_show_id", "season_number", "episode_number");

CREATE UNIQUE INDEX "media_files_path_key" ON "media_files"("path");
CREATE UNIQUE INDEX "media_files_file_path_key" ON "media_files"("file_path");
CREATE UNIQUE INDEX "media_files_symlink_path_key" ON "media_files"("symlink_path");
CREATE UNIQUE INDEX "media_files_strm_path_key" ON "media_files"("strm_path");
CREATE INDEX "media_files_movie_id_idx" ON "media_files"("movie_id");
CREATE INDEX "media_files_episode_id_idx" ON "media_files"("episode_id");
CREATE INDEX "media_files_import_id_idx" ON "media_files"("import_id");
CREATE INDEX "media_files_download_id_idx" ON "media_files"("download_id");
CREATE INDEX "media_files_nzb_id_idx" ON "media_files"("nzb_id");
CREATE INDEX "media_files_vfs_mount_id_idx" ON "media_files"("vfs_mount_id");
CREATE INDEX "media_files_is_available_idx" ON "media_files"("is_available");

CREATE INDEX "MediaRequest_movieId_idx" ON "MediaRequest"("movieId");
CREATE INDEX "MediaRequest_tvShowId_idx" ON "MediaRequest"("tvShowId");
CREATE INDEX "MediaRequest_seasonId_idx" ON "MediaRequest"("seasonId");
CREATE INDEX "MediaRequest_episodeId_idx" ON "MediaRequest"("episodeId");

CREATE INDEX "MediaLibraryItem_movieId_idx" ON "MediaLibraryItem"("movieId");
CREATE INDEX "MediaLibraryItem_tvShowId_idx" ON "MediaLibraryItem"("tvShowId");
CREATE INDEX "MediaLibraryItem_seasonId_idx" ON "MediaLibraryItem"("seasonId");
CREATE INDEX "MediaLibraryItem_episodeId_idx" ON "MediaLibraryItem"("episodeId");

ALTER TABLE "tv_seasons"
  ADD CONSTRAINT "tv_seasons_tv_show_id_fkey"
  FOREIGN KEY ("tv_show_id") REFERENCES "tv_shows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tv_episodes"
  ADD CONSTRAINT "tv_episodes_tv_show_id_fkey"
  FOREIGN KEY ("tv_show_id") REFERENCES "tv_shows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tv_episodes"
  ADD CONSTRAINT "tv_episodes_season_id_fkey"
  FOREIGN KEY ("season_id") REFERENCES "tv_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_files"
  ADD CONSTRAINT "media_files_movie_id_fkey"
  FOREIGN KEY ("movie_id") REFERENCES "movies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_files"
  ADD CONSTRAINT "media_files_episode_id_fkey"
  FOREIGN KEY ("episode_id") REFERENCES "tv_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_files"
  ADD CONSTRAINT "media_files_import_id_fkey"
  FOREIGN KEY ("import_id") REFERENCES "ImportItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "media_files"
  ADD CONSTRAINT "media_files_download_id_fkey"
  FOREIGN KEY ("download_id") REFERENCES "Download"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "media_files"
  ADD CONSTRAINT "media_files_nzb_id_fkey"
  FOREIGN KEY ("nzb_id") REFERENCES "NzbDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "media_files"
  ADD CONSTRAINT "media_files_vfs_mount_id_fkey"
  FOREIGN KEY ("vfs_mount_id") REFERENCES "VfsMount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaRequest"
  ADD CONSTRAINT "MediaRequest_movieId_fkey"
  FOREIGN KEY ("movieId") REFERENCES "movies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaRequest"
  ADD CONSTRAINT "MediaRequest_tvShowId_fkey"
  FOREIGN KEY ("tvShowId") REFERENCES "tv_shows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaRequest"
  ADD CONSTRAINT "MediaRequest_seasonId_fkey"
  FOREIGN KEY ("seasonId") REFERENCES "tv_seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaRequest"
  ADD CONSTRAINT "MediaRequest_episodeId_fkey"
  FOREIGN KEY ("episodeId") REFERENCES "tv_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaLibraryItem"
  ADD CONSTRAINT "MediaLibraryItem_movieId_fkey"
  FOREIGN KEY ("movieId") REFERENCES "movies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaLibraryItem"
  ADD CONSTRAINT "MediaLibraryItem_tvShowId_fkey"
  FOREIGN KEY ("tvShowId") REFERENCES "tv_shows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaLibraryItem"
  ADD CONSTRAINT "MediaLibraryItem_seasonId_fkey"
  FOREIGN KEY ("seasonId") REFERENCES "tv_seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaLibraryItem"
  ADD CONSTRAINT "MediaLibraryItem_episodeId_fkey"
  FOREIGN KEY ("episodeId") REFERENCES "tv_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
