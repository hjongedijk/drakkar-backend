# Drakkar Backend

Fastify + Prisma backend for Drakkar.

Drakkar coordinates request sync, NZB search, download queueing, FUSE-mounted media output, health checks, and the authenticated API used by the frontend.

## Highlights

- Fastify API with OpenAPI docs
- PostgreSQL via Prisma
- Valkey for queueing and distributed cache
- Native FUSE mount support
- NZBHydra2 search + Seerr sync
- Browser playback endpoints
- SAB-compatible queue API

## Version

Current backend version: `0.1.1`

## Runtime layout

Default container paths:

- `/data/config` application config
- `/data/downloads` active downloads
- `/data/completed` completed payloads ready for import
- `/data/nzb` working NZB files
- `/data/nzb-backup` optional NZB backup copies
- `/mnt/media/movies` movie library output
- `/mnt/media/tv` TV library output

FUSE is mounted under `/mnt`, so Plex/Jellyfin/Emby can point at `/mnt/media`.

## Requirements

- PostgreSQL
- Valkey
- Linux host with FUSE available
- shared bind mount on the host for `/mnt`

Prepare the host mount once per boot:

```bash
sudo mkdir -p /mnt
sudo mount --bind /mnt /mnt
sudo mount --make-rshared /mnt
findmnt -T /mnt -o TARGET,PROPAGATION
```

Expected propagation: `shared` or `rshared`.

## Development

```bash
npm install
npx prisma generate
npm run lint
npm run build
npm test
```

Run locally:

```bash
npm run dev
```

## Docker

Build image:

```bash
docker build -t drakkar-backend:latest .
```

The deployment compose file lives in the root project. Public images are published to:

- `ghcr.io/hjongedijk/drakkar-backend`

## Authentication

The backend seeds an initial local admin account on first boot:

- username: `admin`
- password: `password1234`

The frontend no longer prefills these credentials. Change the password after first login.

## API

Important endpoints:

- `/health`
- `/api/status`
- `/api/auth/login`
- `/api/library`
- `/api/downloads/queue`
- `/api/downloads/history`
- `/api/vfs/*`
- `/sabnzbd/api`

## Docs

- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Integrations](docs/integrations.md)
- [Troubleshooting](docs/troubleshooting.md)
