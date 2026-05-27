import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  healthFromStatus,
  shouldHideLibraryItem,
  statusFromRequestAndDownload
} from "../src/services/media-library/libraryShared.js";

describe("libraryShared", () => {
  it("maps failed download state back to searching for approved requests", () => {
    assert.equal(statusFromRequestAndDownload({
      requestStatus: "approved",
      downloadStatus: "failed",
      hasFilesystemEntry: false
    }), "searching");
  });

  it("maps available request without file to grabbed until file exists", () => {
    assert.equal(statusFromRequestAndDownload({
      requestStatus: "available",
      hasFilesystemEntry: false
    }), "grabbed");
  });

  it("hides placeholder request rows with no metadata", () => {
    assert.equal(shouldHideLibraryItem({
      sourceKey: "request:abc",
      title: "Request 1234",
      posterUrl: null,
      backdropUrl: null
    }), true);
  });

  it("keeps imported rows visible when metadata exists", () => {
    assert.equal(shouldHideLibraryItem({
      sourceKey: "import:abc",
      title: "NCIS",
      tmdbId: "4614"
    }), false);
  });

  it("maps failed statuses to import_failed health", () => {
    assert.equal(healthFromStatus("release_failed"), "import_failed");
  });
});
