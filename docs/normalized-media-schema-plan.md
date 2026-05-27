# Normalized Media Schema Plan

This is the first additive migration pass for Drakkar media normalization.

## Scope

Added normalized metadata/file tables:

- `movies`
- `tv_shows`
- `tv_seasons`
- `tv_episodes`
- `media_files`

Extended existing tables:

- `MediaRequest`
  - `movieId`
  - `tvShowId`
  - `seasonId`
  - `episodeId`
  - `rawRequest`
  - `rawMedia`
- `MediaLibraryItem`
  - `movieId`
  - `tvShowId`
  - `seasonId`
  - `episodeId`

## Source Of Truth

- metadata
  - `movies`
  - `tv_shows`
  - `tv_seasons`
  - `tv_episodes`
- app/library state
  - `MediaLibraryItem`
- playable file/path state
  - `media_files`
- operational download/NZB/VFS/archive state
  - unchanged existing tables

## Compatibility

Current API response shapes are preserved.

`/api/library` and `/api/library/:id` now prefer normalized metadata when linked, but still return legacy fields like:

- `title`
- `year`
- `tmdbId`
- `tvdbId`
- `imdbId`
- `posterUrl`
- `backdropUrl`
- `overview`
- `episodeTitle`
- `episodeOverview`
- `episodeAirDate`

Request writes also preserve additive raw payloads in:

- `MediaRequest.rawRequest`
- `MediaRequest.rawMedia`

## Validation Commands

Dry-run report:

```bash
cd backend
npm run normalized-media:report
```

Additive backfill:

```bash
cd backend
npm run normalized-media:backfill
```

## Report Output

The report/backfill worker prints JSON including:

- `moviesCreated`
- `tvShowsCreated`
- `seasonsCreated`
- `episodesCreated`
- `mediaRequestsLinked`
- `mediaLibraryItemsLinked`
- `mediaFilesCreated`
- `filesLinkedToMovies`
- `filesLinkedToEpisodes`
- `rowsSkippedMissingTmdbId`
- `rowsSkippedMissingSeason`
- `rowsSkippedMissingEpisode`
- `rowsSkippedUnresolvedTarget`
- `duplicateWarnings`
- `unresolvedRequests`
- `unresolvedLibraryItems`

## Constraints Added

### `movies`

- unique `tmdb_id`
- unique partial `imdb_id`
- unique partial `tvdb_id`
- title index
- year index

### `tv_shows`

- unique `tmdb_id`
- unique partial `imdb_id`
- unique partial `tvdb_id`
- title index
- year index

### `tv_seasons`

- unique `(tv_show_id, season_number)`
- unique partial `tmdb_id`
- unique partial `tvdb_id`
- indexes on `tv_show_id`

### `tv_episodes`

- unique `(tv_show_id, season_number, episode_number)`
- unique `(season_id, episode_number)`
- unique partial `tmdb_id`
- unique partial `imdb_id`
- unique partial `tvdb_id`
- indexes on `tv_show_id`, `season_id`

### `media_files`

- unique nullable `path`
- unique nullable `file_path`
- unique nullable `symlink_path`
- unique nullable `strm_path`
- single-target check:
  - `movie_id` xor `episode_id`
- type-target check:
  - `movie` requires `movie_id`
  - `episode` requires `episode_id`

## Risks

- Existing request rows that target multiple seasons or episodes cannot always resolve to a single `seasonId` or `episodeId` in phase one.
- Existing rows without `tmdbId` are intentionally skipped, not guessed destructively.
- Existing path collisions will be surfaced by `media_files` unique constraints during additive backfill.
- `MediaLibraryItem` and `MediaRequest` remain dual-write/dual-read compatible during this phase, so there is temporary duplication by design.

## Rollback

Before applying the migration:

- do nothing further

After applying the migration but before running backfill:

- rollback is limited to schema rollback only

After backfill:

- old application reads remain intact because no legacy columns are dropped
- rollback can stop using normalized tables without data loss to old columns

## Cleanup Deferred

Not part of this phase:

- dropping legacy metadata columns from `MediaLibraryItem`
- dropping legacy metadata columns from `MediaRequest`
- strict one-target DB checks on `MediaRequest` and `MediaLibraryItem`
- removing old read paths
- destructive dedupe cleanup inside legacy tables
