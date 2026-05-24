# Backend Configuration

The backend reads Drakkar defaults and app settings from `/data/config/settings.json`. Docker Compose uses fixed local defaults for PostgreSQL, Valkey, and ports; no `.env` file is required or documented.

## settings.json

The backend creates `/data/config/settings.json` on first boot with a generated `drakkarApiToken`, infrastructure defaults, and empty integration defaults. The Settings page presents this as the shared `Drakkar API Token`. The setup wizard and Settings page should be used for:

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
- `/data/nzb-backup`: optional backup copies
- `/mnt/downloads`: active payload downloads
- `/mnt/completed`: materialized completed content when required
- `/mnt/nzb`: working NZB files
- `/mnt/media/movies`: movie library output
- `/mnt/media/tv`: TV library output
- `/mnt/fuse`: FUSE VFS mount for direct streaming
- `/mnt/fuse/nzb`: virtual FUSE view of `/mnt/nzb`

## Public compose companions

The shipped public compose now includes these companion services on the same bridge network:

- `seerr`
- `nzbhydra2`
- `bazarr`
- `apprise-api`
- `valkey-insight`

Drakkar itself still reads actual service credentials and endpoints from `settings.json`, not from Compose env files.

## Default NZBHydra Categories

- Movies: `2030`, `2040`, `2045`, `2050`, `2060`
- TV: `5030`, `5040`, `5045`, `5080`
- Optional foreign categories: movie `2010`, TV `5020`
