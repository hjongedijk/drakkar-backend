import { getPolicySettings } from "../policyService.js";
import { listActiveStreamSessions } from "../mountedStream.service.js";

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
  const reservedStreamingCapacity = activeStreamCount > 0 ? allocatedStreamingConnections : 0;
  const remainingAfterStreamingReservation = Math.max(0, maxTotalConnections - reservedStreamingCapacity);
  const effectiveDownloadCap = Math.min(
    maxTotalConnections,
    maxDownloadConnections + Math.max(0, maxStreamingConnections - allocatedStreamingConnections)
  );
  const maintenanceFloor = maxDownloadConnections > 0 ? 1 : 0;
  const playbackDownloadLane = activeStreamCount > 0
    ? Math.min(2, maxDownloadConnections, remainingAfterStreamingReservation)
    : effectiveDownloadCap;
  const allocatedDownloadConnections = activeStreamCount > 0
    ? clamp(playbackDownloadLane, 0, effectiveDownloadCap)
    : clamp(
        Math.min(effectiveDownloadCap, Math.max(maintenanceFloor, remainingAfterStreamingReservation)),
        0,
        effectiveDownloadCap
      );

  return {
    activeStreamCount,
    queueThrottleActive: false,
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
