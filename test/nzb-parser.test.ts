import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNzbXml } from "../src/nzb/parser.js";

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="poster@example.com" date="1778940000" subject="Movie.2026.1080p.WEB-DL-GROUP yEnc (1/2)">
    <groups>
      <group>alt.binaries.test</group>
    </groups>
    <segments>
      <segment bytes="100" number="1">article-1@example.com</segment>
      <segment bytes="150" number="2">article-2@example.com</segment>
    </segments>
  </file>
</nzb>`;

describe("parseNzbXml", () => {
  it("extracts files, groups, segments, and total size", () => {
    const parsed = parseNzbXml(fixture, "Movie.2026");

    assert.equal(parsed.valid, true);
    assert.equal(parsed.title, "Movie.2026.1080p.WEB-DL-GROUP yEnc (1/2)");
    assert.equal(parsed.files.length, 1);
    assert.deepEqual(parsed.groups, ["alt.binaries.test"]);
    assert.equal(parsed.totalSize, 250);
    assert.equal(parsed.segmentCount, 2);
    assert.equal(parsed.files[0]?.segments[0]?.articleId, "article-1@example.com");
  });

  it("reports invalid documents with no file entries", () => {
    const parsed = parseNzbXml("<nzb></nzb>", "empty");

    assert.equal(parsed.valid, false);
    assert.ok(parsed.errors.includes("NZB contains no files"));
  });
});
