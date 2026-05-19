# Integrations

## NZBHydra2

Configure in Settings:

- base URL
- API key
- search categories
- timeout
- cache TTL

Drakkar caches NZBHydra2 results in Redis to reduce repeated API traffic.

## Seerr

Seerr providers can be added from the UI or API. Drakkar syncs approved requests, enriches them with metadata, and adds them to the monitored library.

TV flow:

- try full season packs first
- fall back to per-episode grabs if needed
- keep monitoring for missing episodes

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

