# Configuration

Configuration is split across environment variables, database-backed settings, and mounted folders.

## Important environment variables

- `DATABASE_URL`
- `REDIS_URL`
- `BACKEND_PORT`
- `BACKEND_URL`
- `VFS_ROOT`
- `VFS_DOWNLOADS_DIR`
- `VFS_COMPLETED_DIR`
- `VFS_NZB_DIR`
- `NZB_BACKUPS_DIR`
- `MEDIA_SYMLINKS_DIR`
- `MEDIA_MOVIES_DIR`
- `MEDIA_TV_DIR`
- `FUSE_MOUNT_PATH`

Defaults are already set in the backend for the standard Drakkar layout:

- `/data/config`
- `/data/downloads`
- `/data/completed`
- `/data/nzb`
- `/data/nzb-backup`
- `/mnt/media`

Override them only when you want a non-standard layout.

## Runtime layout

- `/data/config` persisted app configuration
- `/data/downloads` active payload downloads
- `/data/completed` verified/completed content before import
- `/data/nzb` working NZB files
- `/data/nzb-backup` optional backup copies of working NZBs
- `/mnt/media/movies` movie output for media servers
- `/mnt/media/tv` TV output for media servers

## Settings UI

Most integrations are configured in the frontend Settings page:

- NZBHydra2
- Seerr
- Usenet providers
- quality profiles
- queue/import policy
- NZB backup toggle

