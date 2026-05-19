# Drakkar Backend

Fastify + Prisma backend for Drakkar.

## Runtime layout

- `/data/downloads` active downloads
- `/data/completed` finished files
- `/data/nzb` working NZBs
- `/data/nzb-backup` optional NZB backups
- `/fuse/vfs/media` Plex-facing FUSE path

## Build

```bash
npm install
npm run build
```

## Docker

```bash
docker build -t drakkar-backend:latest .
```
