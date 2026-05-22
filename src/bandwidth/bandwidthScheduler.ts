import { getPolicySettings } from "../policies/policyService.js";
import { listActiveStreamSessions } from "../streaming/mountedStream.service.js";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export async function getBandwidthStatus() {
  const policies = await getPolicySettings();
  const streams = await listActiveStreamSessions();
  const activeStreams = streams.filter((stream) => stream.status === "active");
  const activeStreamCount = activeStreams.length;
  const maxTotalConnections = policies.maxTotalUsenetConnections;
  const maxStreamingConnections = policies.maxStreamingConnections;
  const maxDownloadConnections = policies.maxDownloadConnections;
  const streamingShare = activeStreamCount > 0 ? clamp(policies.streamingPriority / 100, 0, 1) : 0;
  const reservedStreamingConnections = activeStreamCount > 0 ? Math.max(1, Math.floor(maxTotalConnections * streamingShare)) : 0;
  const allocatedStreamingConnections = clamp(
    Math.min(maxStreamingConnections, reservedStreamingConnections),
    0,
    maxTotalConnections
  );
  const reservedStreamingCapacity = activeStreamCount > 0
    ? clamp(reservedStreamingConnections, allocatedStreamingConnections, maxTotalConnections)
    : 0;
  const remainingAfterStreamingReservation = Math.max(0, maxTotalConnections - reservedStreamingCapacity);
  const effectiveDownloadCap = activeStreamCount > 0
    ? Math.min(maxDownloadConnections, remainingAfterStreamingReservation)
    : Math.min(maxTotalConnections, maxDownloadConnections + Math.max(0, maxStreamingConnections - allocatedStreamingConnections));
  const maintenanceFloor = activeStreamCount > 0 ? 0 : maxDownloadConnections > 0 ? 1 : 0;
  const allocatedDownloadConnections = activeStreamCount > 0
    ? clamp(
        Math.min(effectiveDownloadCap, Math.max(maintenanceFloor, remainingAfterStreamingReservation)),
        0,
        effectiveDownloadCap
      )
    : Math.min(effectiveDownloadCap, maxTotalConnections);

  return {
    activeStreamCount,
    queueThrottleActive: activeStreamCount > 0,
    policy: {
      streamingPriority: policies.streamingPriority,
      maxDownloadConnections: policies.maxDownloadConnections,
      maxStreamingConnections: policies.maxStreamingConnections,
      maxTotalUsenetConnections: policies.maxTotalUsenetConnections,
      streamReadAheadBytes: policies.streamReadAheadBytes,
      streamChunkSizeBytes: policies.streamChunkSizeBytes,
      streamCacheEnabled: policies.streamCacheEnabled
    },
    allocation: {
      streaming: allocatedStreamingConnections,
      perStream: activeStreamCount > 0 ? Math.max(1, Math.floor(allocatedStreamingConnections / activeStreamCount)) : 0,
      downloads: allocatedDownloadConnections,
      maintenance: maintenanceFloor
    }
  };
}

export async function getAllowedDownloadConnections() {
  const status = await getBandwidthStatus();
  return Math.max(0, status.allocation.downloads);
}
