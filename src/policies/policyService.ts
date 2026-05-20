import { z } from "zod";
import { prisma } from "../db/prisma.js";

export const duplicateBehaviorSchema = z.enum(["download_again_with_suffix", "mark_failed", "ignore_existing", "replace_existing"]);
export const importStrategySchema = z.enum(["symlink", "strm", "copy"]);
export const queueDecisionActionSchema = z.enum(["do_nothing", "remove", "remove_and_blocklist", "remove_blocklist_and_search", "search_again"]);
export const blockReasonSchema = z.enum([
  "manual",
  "duplicate_nzb",
  "no_video_content",
  "missing_articles",
  "repair_failed",
  "passworded_archive",
  "quality_rejected",
  "ignored_file_only",
  "unsupported_archive",
  "import_failed"
]);

export const policySettingsSchema = z.object({
  streamingPriority: z.number().int().min(0).max(100).default(80),
  maxDownloadConnections: z.number().int().positive().default(20),
  maxStreamingConnections: z.number().int().positive().default(10),
  maxTotalUsenetConnections: z.number().int().positive().default(30),
  streamCacheEnabled: z.boolean().default(true),
  streamCacheMaxSizeGb: z.number().positive().default(20),
  streamCacheMaxAgeHours: z.number().positive().default(24),
  streamChunkSizeBytes: z.number().int().positive().default(4 * 1024 * 1024),
  streamReadAheadBytes: z.number().int().min(0).default(64 * 1024 * 1024),
  duplicateNzbBehavior: duplicateBehaviorSchema.default("mark_failed"),
  failNzbWithoutVideo: z.boolean().default(true),
  manualUploadCategory: z.string().min(1).default("manual"),
  importStrategy: importStrategySchema.default("symlink"),
  queueDecisionActions: z.record(queueDecisionActionSchema).default({})
});

export const ignoredPatternsSchema = z.array(z.string().min(1));

export type PolicySettings = z.infer<typeof policySettingsSchema>;

export const DEFAULT_POLICIES: PolicySettings = {
  streamingPriority: 80,
  maxDownloadConnections: 20,
  maxStreamingConnections: 10,
  maxTotalUsenetConnections: 30,
  streamCacheEnabled: true,
  streamCacheMaxSizeGb: 20,
  streamCacheMaxAgeHours: 24,
  streamChunkSizeBytes: 4 * 1024 * 1024,
  streamReadAheadBytes: 64 * 1024 * 1024,
  duplicateNzbBehavior: "mark_failed",
  failNzbWithoutVideo: true,
  manualUploadCategory: "manual",
  importStrategy: "symlink",
  queueDecisionActions: {
    grabbedSeriesIdMismatch: "do_nothing",
    grabbedMovieIdMismatch: "do_nothing",
    episodeMissingInRelease: "do_nothing",
    unexpectedEpisodes: "do_nothing",
    notEpisodeUpgrade: "remove_and_blocklist",
    notMovieUpgrade: "remove_and_blocklist",
    notCustomFormatUpgrade: "remove_and_blocklist",
    noEligibleFiles: "remove_blocklist_and_search",
    episodeAlreadyImported: "remove",
    noAudioTracks: "remove_blocklist_and_search",
    invalidSeasonEpisode: "do_nothing",
    singleEpisodeContainsSeason: "do_nothing",
    unableToDetermineSample: "do_nothing",
    sample: "remove_blocklist_and_search",
    archiveNeedsExtraction: "do_nothing"
  }
};

export const DEFAULT_IGNORED_PATTERNS = [
  "*.nfo",
  "*.par2",
  "*.sfv",
  "*.srr",
  "*.nzb",
  "*.txt",
  "*.url",
  "*.jpg",
  "*.jpeg",
  "*.png",
  "*.gif",
  "*.bmp",
  "*.webp",
  "*sample*",
  "*.iso",
  "BDMV/**",
  "VIDEO_TS/**"
];

const POLICIES_KEY = "policies";
const IGNORED_KEY = "ignored-files";
const POLICY_CACHE_MS = 30_000;
let cachedPolicies: { value: PolicySettings; expiresAt: number } | null = null;
let cachedIgnoredPatterns: { value: string[]; expiresAt: number } | null = null;

async function enabledUsenetConnectionCount() {
  const aggregate = await prisma.usenetServer.aggregate({
    where: { enabled: true },
    _sum: { connections: true }
  });
  return Math.max(1, aggregate._sum.connections ?? 0);
}

async function derivePolicySettings(input: object) {
  const parsed = policySettingsSchema.parse({ ...DEFAULT_POLICIES, ...input });
  const totalEnabledConnections = await enabledUsenetConnectionCount();

  return {
    ...parsed,
    maxDownloadConnections: totalEnabledConnections,
    maxTotalUsenetConnections: totalEnabledConnections,
    maxStreamingConnections: Math.min(parsed.maxStreamingConnections, totalEnabledConnections)
  } satisfies PolicySettings;
}

async function getSetting<T>(key: string, fallback: T) {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  return row.value as T;
}

export async function getPolicySettings() {
  if (cachedPolicies && cachedPolicies.expiresAt > Date.now()) return cachedPolicies.value;
  const value = await derivePolicySettings(await getSetting(POLICIES_KEY, {}));
  cachedPolicies = { value, expiresAt: Date.now() + POLICY_CACHE_MS };
  return value;
}

export async function updatePolicySettings(input: unknown) {
  const incoming = policySettingsSchema.parse({ ...DEFAULT_POLICIES, ...(input as object) });
  const policies = await derivePolicySettings(incoming);
  await prisma.setting.upsert({
    where: { key: POLICIES_KEY },
    update: { value: policies },
    create: { key: POLICIES_KEY, value: policies }
  });
  cachedPolicies = { value: policies, expiresAt: Date.now() + POLICY_CACHE_MS };
  return policies;
}

export function invalidatePolicyCache() {
  cachedPolicies = null;
}

export async function getIgnoredPatterns() {
  if (cachedIgnoredPatterns && cachedIgnoredPatterns.expiresAt > Date.now()) return cachedIgnoredPatterns.value;
  const value = ignoredPatternsSchema.parse(await getSetting(IGNORED_KEY, DEFAULT_IGNORED_PATTERNS));
  cachedIgnoredPatterns = { value, expiresAt: Date.now() + POLICY_CACHE_MS };
  return value;
}

export async function updateIgnoredPatterns(input: unknown) {
  const patterns = ignoredPatternsSchema.parse(input);
  await prisma.setting.upsert({
    where: { key: IGNORED_KEY },
    update: { value: patterns },
    create: { key: IGNORED_KEY, value: patterns }
  });
  cachedIgnoredPatterns = { value: patterns, expiresAt: Date.now() + POLICY_CACHE_MS };
  return patterns;
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegex(pattern: string) {
  const normalized = pattern.replace(/\\/g, "/").toLowerCase();
  let regex = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegex(char ?? "");
    }
  }
  return new RegExp(`(^|/)${regex}$`, "i");
}

export function matchesIgnoredPattern(path: string, patterns: string[]) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return patterns.some((pattern) => globToRegex(pattern).test(normalized));
}

export async function isIgnoredPath(path: string) {
  return matchesIgnoredPattern(path, await getIgnoredPatterns());
}

export async function testIgnoredPath(path: string) {
  const patterns = await getIgnoredPatterns();
  const matches = patterns.filter((pattern) => globToRegex(pattern).test(path.replace(/\\/g, "/").toLowerCase()));
  return { path, ignored: matches.length > 0, matches };
}

export async function listBlocklist() {
  return prisma.blocklistItem.findMany({ orderBy: { createdAt: "desc" } });
}

export async function createBlocklistItem(input: unknown) {
  const body = z
    .object({
      guid: z.coerce.string().optional(),
      title: z.string().min(1),
      reason: blockReasonSchema.default("manual"),
      source: z.string().optional(),
      release: z.unknown().optional(),
      expiresAt: z.string().datetime().optional()
    })
    .parse(input);

  return prisma.blocklistItem.create({
    data: {
      guid: body.guid,
      title: body.title,
      reason: body.reason,
      source: body.source,
      release: body.release === undefined ? undefined : JSON.parse(JSON.stringify(body.release)),
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined
    }
  });
}

export async function deleteBlocklistItem(id: string) {
  await prisma.blocklistItem.delete({ where: { id } });
  return { ok: true };
}

export async function isReleaseBlocklisted(release: { guid?: unknown; title: string }) {
  const now = new Date();
  const guid = release.guid === undefined || release.guid === null ? undefined : String(release.guid);
  const matches = await prisma.blocklistItem.findMany({
    where: {
      OR: [...(guid ? [{ guid }] : []), { title: { equals: release.title, mode: "insensitive" } }]
    }
  });
  return matches.some((item) => !item.expiresAt || item.expiresAt > now);
}
