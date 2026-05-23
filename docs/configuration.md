# Backend Configuration

The backend reads Drakkar defaults and app settings from `/data/config/settings.json`. Docker Compose uses fixed local defaults for PostgreSQL, Valkey, and ports; no `.env` file is required or documented.

## settings.json

The backend creates `/data/config/settings.json` on first boot with a generated `frontendApiToken`, infrastructure defaults, and empty integration defaults. The setup wizard and Settings page should be used for:

- infrastructure defaults
- NZBHydra2
- Seerr
- Plex
- metadata providers
- Usenet providers
- indexer settings

Keep `/data/config/settings.json` with the database during backups and upgrades.

## Runtime Layout

- `/data/config`: persisted settings
- `/data/downloads`: active payload downloads
- `/data/completed`: materialized completed content when required
- `/data/nzb`: working NZB files
- `/data/nzb-backup`: optional backup copies
- `/mnt/media/movies`: movie library output
- `/mnt/media/tv`: TV library output
- `/mnt/fuse`: FUSE VFS mount for direct streaming

## Default NZBHydra Categories

- Movies: `2030`, `2040`, `2045`, `2050`, `2060`
- TV: `5030`, `5040`, `5045`, `5080`
- Optional foreign categories: movie `2010`, TV `5020`
