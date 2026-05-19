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

## Required services

- PostgreSQL
- Redis
- Linux FUSE support

## Required mounts

Drakkar expects:

- `/data` for writable application state
- `/mnt` as the shared host mount used for FUSE and media output

Example container volumes:

```yaml
volumes:
  - ./data:/data
  - /mnt:/mnt:rshared,z
```

## Host mount propagation

Prepare the host mount once per boot:

```bash
sudo mkdir -p /mnt
sudo mount --bind /mnt /mnt
sudo mount --make-rshared /mnt
findmnt -T /mnt -o TARGET,PROPAGATION
```

Expected result: `shared` or `rshared`.

## First login

Initial local admin account:

- username: `admin`
- password: `password1234`

Enter the password manually in the frontend and change it after first login.

