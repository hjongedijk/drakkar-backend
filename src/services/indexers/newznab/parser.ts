import { XMLParser } from "fast-xml-parser";
import { enrichRelease } from "../../quality/parser.js";
import type { Release } from "../../releases/types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["item", "attr"].includes(name)
});

type NewznabAttr = { name?: string; value?: string };
type NewznabItem = {
  title?: string;
  guid?: unknown;
  link?: string;
  comments?: string;
  pubDate?: string;
  category?: string;
  enclosure?: { url?: string; length?: string };
  attr?: NewznabAttr[];
};

export type NewznabResponse = {
  releases: Release[];
  total?: number;
  offset?: number;
};

function attrMap(attrs?: NewznabAttr[]) {
  return Object.fromEntries((attrs ?? []).filter((attr) => attr.name).map((attr) => [attr.name!, attr.value ?? ""]));
}

function numberAttr(attributes: Record<string, string>, key: string) {
  const value = attributes[key];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringAttr(attributes: Record<string, string>, key: string) {
  const value = attributes[key];
  return value && value.length > 0 ? value : undefined;
}

function normalizeGuid(guid: NewznabItem["guid"], fallback: string) {
  if (typeof guid === "string" || typeof guid === "number" || typeof guid === "bigint") return String(guid);
  if (guid && typeof guid === "object") {
    const value = (guid as { "#text"?: unknown })["#text"];
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  }
  return fallback;
}

export function parseNewznabResponse(xml: string, indexer = "NZBHydra2"): NewznabResponse {
  const parsed = parser.parse(xml) as { rss?: { channel?: { item?: NewznabItem[]; "newznab:response"?: { total?: string; offset?: string } } } };
  const response = parsed.rss?.channel?.["newznab:response"];
  const items = parsed.rss?.channel?.item ?? [];

  return {
    releases: items.map((item) => {
      const attributes = attrMap(item.attr);
      const title = item.title ?? "Untitled release";
      const downloadUrl = item.enclosure?.url ?? item.link;
      const hydraIndexerName = stringAttr(attributes, "hydraIndexerName");

      return enrichRelease({
        title,
        guid: normalizeGuid(item.guid, downloadUrl ?? title),
        detailsUrl: item.comments ?? item.link,
        downloadUrl,
        indexer: hydraIndexerName ?? indexer,
        category: item.category ?? stringAttr(attributes, "category"),
        size: Number(item.enclosure?.length ?? attributes.size) || undefined,
        age: numberAttr(attributes, "age"),
        grabs: numberAttr(attributes, "grabs"),
        seeders: numberAttr(attributes, "seeders"),
        publishDate: item.pubDate,
        imdbId: stringAttr(attributes, "imdb"),
        tmdbId: stringAttr(attributes, "tmdbid"),
        tvdbId: stringAttr(attributes, "tvdbid"),
        season: numberAttr(attributes, "season"),
        episode: numberAttr(attributes, "episode"),
        rawAttributes: attributes
      });
    }),
    total: response?.total ? Number(response.total) : undefined,
    offset: response?.offset ? Number(response.offset) : undefined
  };
}

export function parseNewznabXml(xml: string, indexer = "NZBHydra2"): Release[] {
  return parseNewznabResponse(xml, indexer).releases;
}

export function normalizeNewznabJson(input: unknown, indexer = "NZBHydra2"): Release[] {
  const data = input as { channel?: { item?: NewznabItem[] }; items?: NewznabItem[] };
  const items = data.channel?.item ?? data.items ?? [];
  return items.map((item) => parseNewznabXml(`<rss><channel><item><title>${escapeXml(item.title ?? "")}</title></item></channel></rss>`, indexer)[0]).filter(Boolean) as Release[];
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
