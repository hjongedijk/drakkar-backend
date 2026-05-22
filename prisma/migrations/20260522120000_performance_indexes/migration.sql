CREATE INDEX "SearchHistory_createdAt_idx" ON "SearchHistory"("createdAt");

CREATE INDEX "UsenetServer_enabled_isBackup_priority_idx" ON "UsenetServer"("enabled", "isBackup", "priority");

CREATE INDEX "NzbFile_nzbDocumentId_idx" ON "NzbFile"("nzbDocumentId");
CREATE INDEX "NzbSegment_nzbFileId_number_idx" ON "NzbSegment"("nzbFileId", "number");

CREATE INDEX "VfsMount_createdAt_idx" ON "VfsMount"("createdAt");

CREATE INDEX "Download_status_updatedAt_idx" ON "Download"("status", "updatedAt");
CREATE INDEX "Download_createdAt_idx" ON "Download"("createdAt");

CREATE INDEX "RequestProvider_enabled_name_idx" ON "RequestProvider"("enabled", "name");

CREATE INDEX "MediaRequest_downloadId_idx" ON "MediaRequest"("downloadId");
CREATE INDEX "MediaRequest_status_createdAt_idx" ON "MediaRequest"("status", "createdAt");

CREATE INDEX "RepairJob_downloadId_createdAt_idx" ON "RepairJob"("downloadId", "createdAt");

CREATE INDEX "BlocklistItem_createdAt_idx" ON "BlocklistItem"("createdAt");
CREATE INDEX "BlocklistItem_guid_idx" ON "BlocklistItem"("guid");

CREATE INDEX "ImportItem_downloadId_idx" ON "ImportItem"("downloadId");
CREATE INDEX "ImportItem_requestId_idx" ON "ImportItem"("requestId");
CREATE INDEX "ImportItem_mediaType_title_year_season_episode_idx" ON "ImportItem"("mediaType", "title", "year", "season", "episode");
CREATE INDEX "ImportItem_createdAt_idx" ON "ImportItem"("createdAt");

CREATE INDEX "Symlink_importId_idx" ON "Symlink"("importId");
CREATE INDEX "Symlink_status_updatedAt_idx" ON "Symlink"("status", "updatedAt");

CREATE INDEX "MediaLibraryItem_libraryStatus_sortTitle_createdAt_idx" ON "MediaLibraryItem"("libraryStatus", "sortTitle", "createdAt");
CREATE INDEX "MediaLibraryItem_requestId_idx" ON "MediaLibraryItem"("requestId");
CREATE INDEX "MediaLibraryItem_downloadId_idx" ON "MediaLibraryItem"("downloadId");
CREATE INDEX "MediaLibraryItem_filePath_idx" ON "MediaLibraryItem"("filePath");
CREATE INDEX "MediaLibraryItem_lastStreamedAt_idx" ON "MediaLibraryItem"("lastStreamedAt");
