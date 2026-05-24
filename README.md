# Drakkar Backend

Fastify + Prisma backend for Drakkar.

Drakkar coordinates request sync, NZB search, download queueing, FUSE-mounted media output, health checks, and the authenticated API used by the frontend.

## Highlights

- Fastify API with GraphQL + REST
- PostgreSQL via Prisma
- Valkey for queueing and distributed cache
- Native FUSE mount support
- NZBHydra2 search + Seerr sync
- Browser playback endpoints
- SAB-compatible queue API

## Version

Current backend version: `0.1.8`

## Runtime layout

Default container paths:

- `/data/config` application config
- `/data/nzb-backup` optional NZB backup copies
- `/mnt/downloads` active downloads
- `/mnt/completed` completed payloads ready for import
- `/mnt/nzb` working NZB files
- `/mnt/media/movies` movie library output
- `/mnt/media/tv` TV library output

FUSE is mounted under `/mnt/fuse`, so Plex/Jellyfin/Emby can point at `/mnt/media` and the virtual NZB working view appears at `/mnt/fuse/nzb`.
NZB backups stay only in `/data/nzb-backup` and are not exposed in the FUSE tree.

## Requirements

- PostgreSQL
- Valkey
- Linux host with FUSE available
- shared bind mount on the host for `/mnt`

Prepare the host mount once per boot:

```bash
sudo mkdir -p /mnt/drakkar
sudo mount --bind /mnt/drakkar /mnt/drakkar
sudo mount --make-rshared /mnt/drakkar
findmnt -T /mnt/drakkar -o TARGET,PROPAGATION
```

Expected propagation: `shared` or `rshared`.

For persistent boot setup, use the shipped [drakkar-mount.service](drakkar-mount.service) example and the install steps in [docs/installation.md](docs/installation.md).

Valkey host tuning:

```bash
echo "vm.overcommit_memory = 1" | sudo tee /etc/sysctl.d/99-valkey.conf
sudo sysctl -p /etc/sysctl.d/99-valkey.conf
```

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

Deployment compose file:

- [docker-compose.yml](docker-compose.yml)

Public images are published to:

- `ghcr.io/hjongedijk/drakkar-backend`
- `ghcr.io/hjongedijk/drakkar-frontend`

Upgrade running containers:

```bash
docker compose pull
docker compose up -d --force-recreate
docker compose ps
```

For a full stop/start cycle, see [docs/installation.md](docs/installation.md).

## Authentication

There is no fixed default admin account anymore.
On first boot the setup wizard opens before login and creates the first admin plus the main service credentials.

## API

Important endpoints:

- `/health`
- `/docs`
- `/api/status`
- `/api/docs`
- `/api/graphql`
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
