# Legacy Media Column Audit

Last manual audit: 2026-05-27

Purpose:
- list flat compatibility columns still read in hot runtime paths
- guide small safe drop migrations later

## `media_requests` flat compatibility columns still read

Still read in hot paths:
- `title`
- `year`
- `tmdbId`
- `tvdbId`
- `imdbId`
- `seasons`
- `episodes`

Main runtime readers:
- `src/services/requests/sync/mediaRequestService.ts`
- `src/services/requests/sync/service.ts`
- `src/services/symlinkService.ts`
- `src/services/importService.ts`
- `src/services/requests/recovery/releaseRecoveryService.ts`
- `src/services/subtitleService.ts`

Notes:
- normalized target links now preferred first where available
- flat fields still needed for fallback search, provider payload preservation, and unresolved legacy rows

## `media_library_items` flat compatibility columns still read

Still read in hot paths:
- `title`
- `sortTitle`
- `year`
- `tmdbId`
- `tvdbId`
- `imdbId`
- `season`
- `episode`
- `requestedBy`
- `requestProvider`
- `folderPath`
- `filePath`
- `symlinkPath`
- `strmPath`
- `quality`
- `source`
- `codec`
- `audio`
- `releaseGroup`
- `size`
- `duration`

Main runtime readers:
- `src/services/libraryService.ts`
- `src/services/media-library/libraryQueries.ts`
- `src/services/media-library/libraryRefresh.ts`
- `src/services/mountedStream.service.ts`
- `src/pages/Library.tsx` via API shape
- `src/pages/Dashboard.tsx` via API shape

Notes:
- dropped already:
  - `posterUrl`
  - `backdropUrl`
  - `overview`
  - `metadataProvider`
  - `metadataUpdatedAt`
  - `episodeTitle`
  - `episodeOverview`
  - `episodeAirDate`
- normalized metadata now source of truth
- remaining fields above mostly app state or compatibility response shape

## Next safe drop order

1. `media_library_items`
- `tmdbId`
- `tvdbId`
- `imdbId`

2. `media_requests`
- `tmdbId`
- `tvdbId`
- `imdbId`

3. later only after API shape cutover
- `title`
- `year`
- `season`
- `episode`

Do not drop yet:
- request/library state columns
- path columns now duplicated by `media_files`
- `seasons` / `episodes` JSON until request targeting fully normalized for partial-season / multi-episode cases
