export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProviderConnectionLimit(message: string) {
  return /too many connections/i.test(message);
}

export function isTemporaryProviderError(message: string) {
  return /too many connections|timeout|temporarily|try again|connection.*reset|econnreset|etimedout/i.test(message);
}

export function createAbortError() {
  const error = new Error("stream aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

export function segmentCacheKey(fileId: string, segmentNumber: number) {
  return `${fileId}:${segmentNumber}`;
}

export function findSegmentIndex<T extends { start: number; end: number }>(segments: T[], offset: number) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (!segment) break;
    if (offset < segment.start) high = mid - 1;
    else if (offset > segment.end) low = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(low, segments.length - 1));
}
