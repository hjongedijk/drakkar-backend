import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../models/generated/prisma/client.js";
import { env } from "../../services/config/env.js";

export {
  PrismaClient,
  Prisma
} from "../../models/generated/prisma/client.js";
export type {
  ApiKey,
  ArchiveEntry,
  ArchiveSegment,
  AuditLog,
  BlocklistItem,
  Download,
  FailedRelease,
  ImportItem,
  MediaFile,
  MediaLibraryItem,
  MediaRequest,
  Movie,
  NzbDocument,
  NzbFile,
  NzbSegment,
  QualityProfile,
  QualityRule,
  ReleaseDecision,
  RepairJob,
  RequestProvider,
  SearchHistory,
  Setting,
  Symlink,
  TvEpisode,
  TvSeason,
  TvShow,
  UsenetServer,
  User,
  VfsMount
} from "../../models/generated/prisma/client.js";

export const prisma = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: env.DATABASE_URL })),
  log: ["error", "warn"]
});
