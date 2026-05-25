import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";

export const duplicateBehaviorSchema = z.enum(["download_again_with_suffix", "mark_failed", "ignore_existing", "replace_existing"]);
export const importStrategySchema = z.enum(["symlink", "strm", "copy"]);
const queueDecisionKeys = [
  "grabbedSeriesIdMismatch",
  "grabbedMovieIdMismatch",
  "episodeMissingInRelease",
  "unexpectedEpisodes",
  "notEpisodeUpgrade",
  "notMovieUpgrade",
  "notCustomFormatUpgrade",
  "noEligibleFiles",
  "episodeAlreadyImported",
  "noAudioTracks",
  "invalidSeasonEpisode",
  "singleEpisodeContainsSeason",
  "unableToDetermineSample",
  "sample",
  "archiveNeedsExtraction",
  "missingArticles"
] as const;

export const queueDecisionActionSchema = z.enum(["do_nothing", "remove", "remove_and_blocklist", "remove_blocklist_and_search", "search_again"]);
export const queueDecisionKeySchema = z.enum(queueDecisionKeys);
export type QueueDecisionKey = z.infer<typeof queueDecisionKeySchema>;
export type QueueDecisionAction = z.infer<typeof queueDecisionActionSchema>;
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
  "grab_failed",
  "import_failed"
]);

const blocklistCreateSchema = z.object({
  guid: z.coerce.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  reason: blockReasonSchema.default("manual"),
  source: z.string().trim().min(1).optional(),
  release: z.unknown().optional(),
  expiresAt: z.string().datetime().optional()
});

const blocklistUpdateSchema = z.object({
  guid: z.coerce.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).optional(),
  reason: blockReasonSchema.optional(),
  source: z.string().trim().min(1).nullable().optional(),
  release: z.unknown().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional()
});

export const blocklistQuerySchema = z.object({
  q: z.string().trim().optional(),
  reason: z.string().trim().optional(),
  source: z.string().trim().optional(),
  state: z.enum(["all", "active", "expired"]).default("all"),
  limit: z.coerce.number().int().positive().max(500).default(200)
});

export const policySettingsSchema = z.object({
  streamingPriority: z.number().int().min(0).max(100).default(80),
  maxDownloadConnections: z.number().int().min(0).default(20),
  maxStreamingConnections: z.number().int().min(0).default(10),
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
    invalidSeasonEpisode: "remove_blocklist_and_search",
    singleEpisodeContainsSeason: "do_nothing",
    unableToDetermineSample: "do_nothing",
    sample: "remove_blocklist_and_search",
    archiveNeedsExtraction: "remove_blocklist_and_search",
    missingArticles: "remove_blocklist_and_search"
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

export function normalizePolicyConnectionBudgets(input: {
  totalEnabledConnections: number;
  maxStreamingConnections: number;
  maxDownloadConnections: number;
}) {
  const totalEnabledConnections = Math.max(1, input.totalEnabledConnections);
  return {
    maxStreamingConnections: Math.min(Math.max(0, input.maxStreamingConnections), totalEnabledConnections),
    maxDownloadConnections: Math.min(Math.max(0, input.maxDownloadConnections), totalEnabledConnections),
    maxTotalUsenetConnections: totalEnabledConnections
  };
}

async function derivePolicySettings(input: object) {
  const parsed = policySettingsSchema.parse({ ...DEFAULT_POLICIES, ...input });
  const totalEnabledConnections = await enabledUsenetConnectionCount();
  const budgets = normalizePolicyConnectionBudgets({
    totalEnabledConnections,
    maxStreamingConnections: parsed.maxStreamingConnections,
    maxDownloadConnections: parsed.maxDownloadConnections
  });

  return {
    ...parsed,
    ...budgets
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

function blocklistState(item: { expiresAt: Date | null }) {
  const expired = Boolean(item.expiresAt && item.expiresAt <= new Date());
  return {
    active: !expired,
    expired
  };
}

function presentBlocklistItem(item: Awaited<ReturnType<typeof prisma.blocklistItem.findFirstOrThrow>>) {
  if (!item) return item;
  return {
    ...item,
    ...blocklistState(item)
  };
}

export async function listBlocklist(input: unknown = {}) {
  const query = blocklistQuerySchema.parse(input);
  const now = new Date();
  const where = {
    AND: [
      query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: "insensitive" as const } },
              { guid: { contains: query.q, mode: "insensitive" as const } }
            ]
          }
        : {},
      query.reason ? { reason: query.reason } : {},
      query.source ? { source: { contains: query.source, mode: "insensitive" as const } } : {},
      query.state === "active" ? { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } : {},
      query.state === "expired" ? { expiresAt: { lte: now } } : {}
    ]
  };

  const items = await prisma.blocklistItem.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    take: query.limit
  });
  return items.map((item) => presentBlocklistItem(item)!);
}

export async function getBlocklistStats() {
  const items = await prisma.blocklistItem.findMany({
    select: { reason: true, source: true, expiresAt: true }
  });
  const now = Date.now();
  const reasons = Object.create(null) as Record<string, number>;
  const sources = Object.create(null) as Record<string, number>;
  let active = 0;
  let expired = 0;

  for (const item of items) {
    reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
    if (item.source) sources[item.source] = (sources[item.source] ?? 0) + 1;
    if (item.expiresAt && item.expiresAt.getTime() <= now) expired += 1;
    else active += 1;
  }

  return {
    total: items.length,
    active,
    expired,
    reasons,
    sources
  };
}

export async function createBlocklistItem(input: unknown) {
  const body = blocklistCreateSchema.parse(input);
  const release = body.release === undefined ? undefined : JSON.parse(JSON.stringify(body.release));
  const normalizedIncomingTitle = normalizeReleaseTitle(body.title);

  if (body.guid) {
    const existing = await prisma.blocklistItem.findFirst({ where: { guid: body.guid } }).catch(() => null);
    if (existing) {
      const updated = await prisma.blocklistItem.update({
        where: { id: existing.id },
        data: {
          title: body.title,
          reason: body.reason,
          source: body.source ?? existing.source,
          release,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : existing.expiresAt
        }
      });
      invalidateBlocklistCache();
      return updated;
    }
  }

  const titleCandidates = await prisma.blocklistItem.findMany({
    where: {
      title: { contains: body.title.split(".")[0]?.split(" ")[0] ?? body.title, mode: "insensitive" }
    },
    orderBy: { createdAt: "desc" },
    take: 500
  }).catch(() => null);
  const existingByTitle = titleCandidates?.find((item) =>
    normalizeReleaseTitle(item.title) === normalizedIncomingTitle &&
    item.reason === body.reason &&
    item.source === body.source
  );
  if (existingByTitle) {
    const updated = await prisma.blocklistItem.update({
      where: { id: existingByTitle.id },
      data: {
        release,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : existingByTitle.expiresAt
      }
    });
    invalidateBlocklistCache();
    return updated;
  }

  try {
    const created = await prisma.blocklistItem.create({
      data: {
        guid: body.guid,
        title: body.title,
        reason: body.reason,
        source: body.source,
        release,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined
      }
    });
    invalidateBlocklistCache();
    return created;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      body.guid
    ) {
      const existing = await prisma.blocklistItem.findFirstOrThrow({ where: { guid: body.guid } });
      const updated = await prisma.blocklistItem.update({
        where: { id: existing.id },
        data: { title: body.title, reason: body.reason, source: body.source, release }
      });
      invalidateBlocklistCache();
      return updated;
    }
    throw error;
  }
}

export async function updateBlocklistItem(id: string, input: unknown) {
  const body = blocklistUpdateSchema.parse(input);
  const updated = await prisma.blocklistItem.update({
    where: { id },
    data: {
      ...(body.guid !== undefined ? { guid: body.guid || null } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.source !== undefined ? { source: body.source || null } : {}),
      ...(body.release !== undefined ? { release: body.release === null ? Prisma.JsonNull : (body.release as Prisma.InputJsonValue) } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {})
    }
  });
  invalidateBlocklistCache();
  return presentBlocklistItem(updated);
}

export async function deleteBlocklistItem(id: string) {
  await prisma.blocklistItem.delete({ where: { id } });
  invalidateBlocklistCache();
  return { ok: true };
}

export async function deleteExpiredBlocklistItems() {
  const result = await prisma.blocklistItem.deleteMany({
    where: { expiresAt: { lte: new Date() } }
  });
  invalidateBlocklistCache();
  return { deleted: result.count };
}

export async function clearBlocklistItems() {
  const result = await prisma.blocklistItem.deleteMany({});
  invalidateBlocklistCache();
  return { deleted: result.count };
}

type BlocklistReleaseInput = {
  guid?: unknown;
  title: string;
  size?: number;
  publishDate?: string;
  indexer?: string;
};

type BlocklistCandidate = {
  id: string;
  guid: string | null;
  title: string;
  reason: string;
  source: string | null;
  release: Prisma.JsonValue | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const ACTIVE_BLOCKLIST_CACHE_TTL_MS = 15_000;
let activeBlocklistCache: { expiresAt: number; items: BlocklistCandidate[] } | null = null;
let activeBlocklistLoad: Promise<BlocklistCandidate[]> | null = null;

function invalidateBlocklistCache() {
  activeBlocklistCache = null;
  activeBlocklistLoad = null;
}

async function getActiveBlocklistCandidates() {
  const now = Date.now();
  if (activeBlocklistCache && activeBlocklistCache.expiresAt > now) return activeBlocklistCache.items;
  if (activeBlocklistLoad) return activeBlocklistLoad;

  activeBlocklistLoad = prisma.blocklistItem.findMany({
    where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }] },
    orderBy: { createdAt: "desc" },
    take: 20_000
  }).then((items) => {
    activeBlocklistCache = { expiresAt: Date.now() + ACTIVE_BLOCKLIST_CACHE_TTL_MS, items };
    activeBlocklistLoad = null;
    return items;
  }).catch((error) => {
    activeBlocklistLoad = null;
    throw error;
  });

  return activeBlocklistLoad;
}

function normalizeReleaseTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/-[a-z0-9]+$/i, "")
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseJsonField(item: { release: Prisma.JsonValue | null }, key: string) {
  if (!item.release || typeof item.release !== "object" || Array.isArray(item.release)) return undefined;
  const value = (item.release as Record<string, unknown>)[key];
  return value;
}

function sameSavedRelease(item: { guid: string | null; title: string; release: Prisma.JsonValue | null }, release: BlocklistReleaseInput) {
  const guid = release.guid === undefined || release.guid === null ? "" : String(release.guid);
  if (guid && item.guid === guid) return true;
  if (normalizeReleaseTitle(item.title) === normalizeReleaseTitle(release.title)) return true;

  const savedTitle = releaseJsonField(item, "title");
  if (typeof savedTitle === "string" && normalizeReleaseTitle(savedTitle) === normalizeReleaseTitle(release.title)) return true;

  const savedSize = Number(releaseJsonField(item, "size"));
  const savedDate = releaseJsonField(item, "publishDate");
  const savedIndexer = releaseJsonField(item, "indexer");
  const sizeMatches = Number.isFinite(savedSize) && typeof release.size === "number" && Math.abs(savedSize - release.size) <= 2 * 1024 * 1024;
  const dateMatches = typeof savedDate === "string" && release.publishDate
    ? Math.abs(new Date(savedDate).getTime() - new Date(release.publishDate).getTime()) <= 2 * 60 * 1000
    : false;
  const indexerMatches = typeof savedIndexer !== "string" || !release.indexer || savedIndexer.toLowerCase() === release.indexer.toLowerCase();
  return Boolean(sizeMatches && dateMatches && indexerMatches);
}

async function activeBlocklistMatches(release: BlocklistReleaseInput) {
  const now = new Date();
  const guid = release.guid === undefined || release.guid === null ? undefined : String(release.guid);
  return (await getActiveBlocklistCandidates())
    .filter((item) => (!item.expiresAt || item.expiresAt > now) && (!guid || item.guid === guid || sameSavedRelease(item, release)))
    .filter((item) => sameSavedRelease(item, release));
}

export async function isReleaseBlocklisted(release: BlocklistReleaseInput) {
  return (await activeBlocklistMatches(release)).length > 0;
}

export async function matchBlocklistRelease(release: BlocklistReleaseInput) {
  return (await activeBlocklistMatches(release))
    .map((item) => presentBlocklistItem(item)!)
}

export function getPolicyUsageReport() {
  return {
    active: {
      streamingPriority: "used by bandwidth scheduler and mounted stream pool",
      maxDownloadConnections: "used by bandwidth scheduler and download connection allocation",
      maxStreamingConnections: "used by bandwidth scheduler and mounted stream pool",
      maxTotalUsenetConnections: "derived from enabled providers and used by bandwidth scheduler",
      streamCacheEnabled: "used by mounted stream segment cache",
      streamCacheMaxSizeGb: "used by mounted stream segment cache pruning",
      streamCacheMaxAgeHours: "used by mounted stream segment cache pruning",
      streamChunkSizeBytes: "used by FUSE/native stream read chunk limit and status",
      streamReadAheadBytes: "used by mounted stream read-ahead window and status",
      duplicateNzbBehavior: "used by NZB import duplicate handling",
      failNzbWithoutVideo: "used by NZB payload validation",
      importStrategy: "used by symlink/STRM import strategy",
      queueDecisionActions: "used by worker failure handling for import/download queue outcomes",
      manualUploadCategory: "used as the default category/source marker for manual NZB uploads"
    },
    inactive: {}
  };
}

export function classifyQueueDecisionKey(message: string): QueueDecisionKey | null {
  const normalized = message.toLowerCase();
  if (/already exists|already imported|working library item already exists/.test(normalized)) return "episodeAlreadyImported";
  if (/430 no such article|no such article|article.*not found|missing article|missing segment|segment download failed/.test(normalized)) return "missingArticles";
  if (/no streamable video|no eligible files|no importable media|contains no streamable video/.test(normalized)) return "noEligibleFiles";
  if (/no audio/.test(normalized)) return "noAudioTracks";
  if (/sample/.test(normalized)) return "sample";
  if (/archive|rar|7z|zip/.test(normalized)) return "archiveNeedsExtraction";
  if (/invalid season|invalid episode|season\/episode mismatch|cannot be symlinked without a valid season and episode/.test(normalized)) return "invalidSeasonEpisode";
  if (/not movie upgrade/.test(normalized)) return "notMovieUpgrade";
  if (/not episode upgrade/.test(normalized)) return "notEpisodeUpgrade";
  if (/not custom format upgrade/.test(normalized)) return "notCustomFormatUpgrade";
  return null;
}

export function getQueueDecisionAction(policies: PolicySettings, key: QueueDecisionKey | null): QueueDecisionAction {
  if (!key) return "do_nothing";
  return policies.queueDecisionActions[key] ?? DEFAULT_POLICIES.queueDecisionActions[key] ?? "do_nothing";
}
