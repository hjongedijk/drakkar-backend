# Troubleshooting

## FUSE mount not visible

Check host propagation:

```bash
findmnt -T /mnt -o TARGET,PROPAGATION
```

If it is not `shared` or `rshared`, redo the bind mount step.

## Downloads stuck or failing

Check:

- enabled Usenet providers
- NZBHydra2 connectivity
- `/api/downloads/queue`
- `/api/downloads/history`
- `/api/diagnostics`
- backend logs

## No playable video found

Possible causes:

- bad/obfuscated release
- incomplete articles on provider
- archive/repair failure
- release did not contain the expected episode

Health and repair details are exposed through the `/health` page and related API routes.

## Playback slow or falling back to transcode

Drakkar tries direct playback first, then falls back to compatible streaming when needed. Slow startup usually means:

- browser codec mismatch
- FUSE/media source latency
- remote provider throughput bottleneck

## Authentication issues

Initial admin is seeded on first boot:

- `admin`
- `password1234`

If login fails after changes, verify:

- backend and frontend share the same API origin/token setup
- cookies are not blocked
- the password was not changed previously

