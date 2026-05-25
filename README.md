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

Current backend version: `0.2.8`

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
- `/api/webhooks/seerr`
- `/api/compat/sonarr`
- `/api/compat/radarr`
- `/api/library`
- `/api/downloads/queue`
- `/api/downloads/history`
- `/api/vfs/*`
- `/sabnzbd/api`

## Request intake

- Single Seerr approvals should use the webhook at `/api/webhooks/seerr`
- Periodic bulk request sync now runs every 15 minutes by default
- The webhook path is intended to keep individual requests fast without forcing constant full-library polling

## Docs

- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Integrations](docs/integrations.md)
- [Community & Legal](docs/community.md)
- [Troubleshooting](docs/troubleshooting.md)

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-change`
3. Commit your changes: `git commit -m "Add my feature"`
4. Push the branch: `git push origin feature/my-change`
5. Open a Pull Request

Please keep contributions focused and describe clearly what your change improves.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

You are free to use, modify, and distribute it, provided the license terms are respected.

## Disclaimer

This project is provided as-is without warranty of any kind.

The author(s) are not responsible for any damage, data loss, misconfiguration, or security issues resulting from the use of this repository, its scripts, containers, or deployment examples.

By using this repository, you agree that you run it at your own risk and that you are responsible for reviewing changes before execution.

Drakkar does not ship with movies, shows, subtitles, or indexer content. Do not use this project to infringe copyright, pirate media, or violate the laws and service terms that apply in your country or to the systems you connect.
