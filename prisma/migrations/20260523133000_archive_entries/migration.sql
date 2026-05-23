-- Persist nzbdav-style archive inner-file maps so archive metadata is not rebuilt every stream.
CREATE TABLE "ArchiveEntry" (
    "id" TEXT NOT NULL,
    "nzbDocumentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "compression" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'streamable',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArchiveEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchiveSegment" (
    "id" TEXT NOT NULL,
    "archiveEntryId" TEXT NOT NULL,
    "nzbFileId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "segmentNumber" INTEGER NOT NULL,
    "bytes" DOUBLE PRECISION NOT NULL,
    "start" DOUBLE PRECISION NOT NULL,
    "end" DOUBLE PRECISION NOT NULL,
    "sourceOffset" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "ArchiveSegment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArchiveEntry_nzbDocumentId_path_key" ON "ArchiveEntry"("nzbDocumentId", "path");
CREATE INDEX "ArchiveEntry_nzbDocumentId_idx" ON "ArchiveEntry"("nzbDocumentId");
CREATE INDEX "ArchiveSegment_archiveEntryId_start_idx" ON "ArchiveSegment"("archiveEntryId", "start");

ALTER TABLE "ArchiveEntry" ADD CONSTRAINT "ArchiveEntry_nzbDocumentId_fkey" FOREIGN KEY ("nzbDocumentId") REFERENCES "NzbDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchiveSegment" ADD CONSTRAINT "ArchiveSegment_archiveEntryId_fkey" FOREIGN KEY ("archiveEntryId") REFERENCES "ArchiveEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
