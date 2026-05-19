export function humanizeDownloadError(message?: string | null) {
  if (!message) return null;
  if (/too many connections/i.test(message)) {
    return "Usenet provider reached its connection limit. Automatic retry scheduled.";
  }
  if (/all providers failed STAT .*430 No Such Article/i.test(message) || /430 No Such Article/i.test(message)) {
    return "Release is missing required Usenet articles on the configured provider(s).";
  }
  if (/all providers failed/i.test(message) && /article|segment|stat/i.test(message)) {
    return "Release could not be verified because required Usenet articles were unavailable.";
  }
  if (/no enabled Usenet providers configured/i.test(message)) {
    return "No enabled Usenet provider is configured.";
  }
  if (/mounted NZB contains no streamable video/i.test(message)) {
    return "Release mounted, but no playable video file was found after validation.";
  }
  if (/duplicate NZB already exists/i.test(message)) {
    return "Duplicate NZB detected.";
  }
  if (/NZB contains no video or archive payload files/i.test(message)) {
    return "NZB does not contain a usable video payload.";
  }
  return message;
}

export function statusLabelForDownload(status: string, error?: string | null) {
  const labels: Record<string, string> = {
    queued: "Queued",
    fetching_nzb: "Fetching NZB",
    verifying: "Validating release",
    downloading: "Downloading release",
    prepared: "Validated and ready",
    mounted: "Mounted",
    waiting_for_provider: "Waiting for provider capacity",
    waiting_for_nzb: "Waiting for NZB",
    paused: "Paused",
    available: "Added to library",
    completed: "Completed",
    failed: error ? "Failed" : "Failed",
    cancelled: "Cancelled",
    replaced: "Replaced"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}
