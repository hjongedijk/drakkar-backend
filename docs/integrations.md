# Integrations

## NZBHydra2

Configure in Settings:

- base URL
- API key
- search categories
- timeout
- cache TTL

Drakkar caches NZBHydra2 results in Redis to reduce repeated API traffic.

In the public compose, `nzbhydra2` is included as a companion service and normally exposes:

```txt
http://nzbhydra2:5076
```

## Seerr

Seerr providers can be added from the UI or API. Drakkar syncs approved requests, enriches them with metadata, and adds them to the monitored library.

Recommended intake model:

- use Seerr webhook `POST /api/webhooks/seerr` for fast single approved requests
- keep periodic request sync enabled for backlog reconciliation and duplicate cleanup

Default periodic sync cadence is now `15 minutes`.

TV flow:

- try full season packs first
- fall back to per-episode grabs if needed
- keep monitoring for missing episodes

## Bazarr

Bazarr can connect to Drakkar through Arr-compatible endpoints:

```txt
/api/compat/sonarr
/api/compat/radarr
```

Use the shared `Drakkar API Token` as the Bazarr API key.

Typical Bazarr internal URLs in the public compose:

```txt
http://backend:3000/api/compat/sonarr
http://backend:3000/api/compat/radarr
```

If Bazarr connects through the frontend instead, use:

```txt
http://frontend/api/compat/sonarr
http://frontend/api/compat/radarr
```

## Apprise API

The public compose includes `apprise-api` as a companion notification service for other stack components.

## Usenet providers

Supported settings:

- host
- port
- SSL
- username/password
- connection limit
- priority
- backup provider
- retention

If no provider is enabled, downloads wait in `waiting_for_provider`.

## SAB-compatible API

Drakkar exposes a basic SAB-compatible endpoint at:

```txt
/sabnzbd/api
```

Supported modes include:

- `version`
- `queue`
- `history`
- `addurl`
- `addfile`
- `pause`
- `resume`
- `delete`
- `get_config`
