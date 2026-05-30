const RECENT_ACTIVITY_WINDOW_MS = 30_000;

type WebdavActivityEvent = {
  at: number;
  method: string;
  path: string;
};

const events: WebdavActivityEvent[] = [];

function trim(now = Date.now()) {
  const cutoff = now - RECENT_ACTIVITY_WINDOW_MS;
  while (events.length > 0 && events[0] && events[0].at < cutoff) events.shift();
}

export function recordWebdavActivity(method: string, path: string) {
  const now = Date.now();
  events.push({ at: now, method, path });
  trim(now);
}

export function getRecentWebdavActivitySummary() {
  const now = Date.now();
  trim(now);
  let propfindCount = 0;
  let mediaPropfindCount = 0;
  let streamReadCount = 0;
  for (const event of events) {
    if (event.method === "PROPFIND") {
      propfindCount += 1;
      if (
        event.path.startsWith("/media") ||
        event.path.startsWith("/content") ||
        event.path.startsWith("/completed-symlinks") ||
        event.path.startsWith("/mounted/releases")
      ) mediaPropfindCount += 1;
    }
    if (event.method === "GET" || event.method === "HEAD") streamReadCount += 1;
  }
  return {
    windowMs: RECENT_ACTIVITY_WINDOW_MS,
    propfindCount,
    mediaPropfindCount,
    streamReadCount,
    scanActive: mediaPropfindCount >= 10 || propfindCount >= 20
  };
}
