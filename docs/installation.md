# Installation

## Docker image

Build locally:

```bash
docker build -t drakkar-backend:latest .
```

Published image:

```txt
ghcr.io/hjongedijk/drakkar-backend:latest
```

## Public compose

Use the release stack from:

- [docker-compose.yml](../docker-compose.yml)

It includes:

- frontend
- backend
- postgres
- valkey
- valkey-insight
- nzbhydra2
- apprise-api
- seerr
- bazarr

## Required services

- PostgreSQL
- Valkey
- Linux FUSE support

Bundled companion services in the public compose:

- `seerr` for requests
- `nzbhydra2` for indexed search
- `bazarr` via Drakkar Arr-compatible endpoints
- `apprise-api` for notification support used by companion apps
- `valkey-insight` for optional Valkey inspection

## Required mounts

Drakkar expects:

- `/data` for writable application state
- `/mnt` inside the container for the shared host tree

With current defaults:

- `./data/config/settings.json` stores runtime config
- `./data/nzb-backup` stores NZB backup copies
- `/mnt/downloads`, `/mnt/completed`, and `/mnt/nzb` are the live working directories
- `/mnt/fuse/nzb` is the virtual FUSE view of `/mnt/nzb`
- NZB backups are not exposed at `/mnt/fuse/nzb-backups`

Release compose uses:

```yaml
volumes:
  - ./data:/data
  - /mnt/drakkar:/mnt:rshared
```

Use `:rshared,z` only on SELinux hosts that require relabeling.

## Compose dependency model

The public compose intentionally only uses `depends_on` for real startup requirements:

- `backend` waits for `postgres` and `valkey`
- `frontend` waits for `backend`
- `valkey-insight` waits for `valkey`
- `bazarr` waits for `backend`
- `nzbhydra2` only waits lightly for `apprise-api`

`seerr`, `apprise-api`, and `nzbhydra2` are not blocked on Drakkar health unless they truly need it to start. This reduces unnecessary restart coupling in larger stacks.

## Host mount propagation

Recommended host service:

`/etc/systemd/system/drakkar-mount.service`

Example file shipped in repo:

- [drakkar-mount.service](../drakkar-mount.service)

```ini
[Unit]
Description=Prepare Drakkar shared bind mount and Valkey host tuning
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
ExecStartPre=/usr/bin/mkdir -p /mnt/drakkar
ExecStartPre=/usr/bin/mkdir -p /mnt/drakkar/media/movies
ExecStartPre=/usr/bin/mkdir -p /mnt/drakkar/media/tv
ExecStartPre=/usr/bin/mkdir -p /mnt/drakkar/fuse
ExecStartPre=/usr/bin/sh -c 'printf "%s\n" "vm.overcommit_memory = 1" > /etc/sysctl.d/99-valkey.conf'
ExecStartPre=/usr/sbin/sysctl -p /etc/sysctl.d/99-valkey.conf
ExecStart=/usr/bin/mount --bind /mnt/drakkar /mnt/drakkar
ExecStart=/usr/bin/mount --make-rshared /mnt/drakkar
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now drakkar-mount.service
findmnt -T /mnt/drakkar -o TARGET,PROPAGATION
```

Expected result: `shared` or `rshared`.

## Valkey host tuning

Valkey can warn if host memory overcommit is disabled. This is a host requirement, not something Drakkar can reliably fix from inside Compose.
The example `drakkar-mount.service` above already applies this on boot.

Recommended:

```bash
echo "vm.overcommit_memory = 1" | sudo tee /etc/sysctl.d/99-valkey.conf
sudo sysctl -p /etc/sysctl.d/99-valkey.conf
```

Verify:

```bash
sysctl vm.overcommit_memory
```

Expected:

```txt
vm.overcommit_memory = 1
```

## First boot

There is no fixed default admin account anymore.

On first boot:

- open the frontend
- finish the setup wizard
- create the first admin
- fill the main NZBHydra2, Usenet, metadata, Seerr, and Plex values

## Upgrading

Recommended upgrade flow:

```bash
docker compose pull
docker compose up -d --force-recreate
docker compose ps
```

Why this is the preferred path:

- `docker compose pull` fetches newer images first
- `docker compose up -d --force-recreate` replaces containers cleanly without tearing down the whole network first
- databases and mounted data stay in place because volumes are preserved

Use a full stop/start only when needed:

```bash
docker compose down
docker compose up -d
```

That is useful when:

- you changed bind mounts
- you changed low-level Docker settings and want a full container restart path
- you are troubleshooting stale networking or mount state

Best practice after upgrading:

```bash
docker compose logs --tail 200 backend
docker compose ps
```

Check that:

- backend is healthy
- frontend is healthy
- FUSE mounted correctly
- no startup migration or mount errors are repeating
