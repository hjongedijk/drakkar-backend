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
- optional `seerr` profile
- optional `debug` profile with Valkey Insight

## Required services

- PostgreSQL
- Valkey
- Linux FUSE support

## Required mounts

Drakkar expects:

- `/data` for writable application state
- `/mnt` inside the container for the shared host tree

Release compose uses:

```yaml
volumes:
  - ./data:/data
  - /mnt/drakkar:/mnt:rshared
```

Use `:rshared,z` only on SELinux hosts that require relabeling.

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
