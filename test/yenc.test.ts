import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeArticleBody } from "../src/usenet/yenc.js";

function encodeYenc(input: Buffer) {
  let output = "";
  for (const byte of input) {
    const encoded = (byte + 42) % 256;
    if ([0, 9, 10, 13, 61].includes(encoded)) {
      output += `=${String.fromCharCode((encoded + 64) % 256)}`;
    } else {
      output += String.fromCharCode(encoded);
    }
  }
  return output;
}

describe("decodeArticleBody", () => {
  it("ignores NNTP ARTICLE headers before yEnc payload", () => {
    const original = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
    const body = [
      "Path: news.example",
      "From: poster@example.com",
      '=ybegin line=128 size=8 name="sample.mkv"',
      encodeYenc(original),
      "=yend size=8"
    ].join("\r\n");

    assert.deepEqual(decodeArticleBody(body), original);
  });
});
