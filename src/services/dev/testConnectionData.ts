import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../../repositories/db/prisma.js";
import { getSettings, updateSettings } from "../settings/settingsStore.js";

const providerSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  ssl: z.boolean().default(true),
  username: z.string().optional(),
  password: z.string().optional(),
  connections: z.number().int().positive().default(10)
});

const indexerSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  api_key: z.string().min(1)
});

const requesterSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  api_key: z.string().min(1)
});

const mediaSchema = z.object({
  name: z.string().min(1),
  api_key: z.string().min(1)
});

const testConnectionSchema = z.object({
  "usenet-providers": z.array(providerSchema).default([]),
  indexers: z.array(indexerSchema).default([]),
  requesters: z.array(requesterSchema).default([]),
  media: z.array(mediaSchema).default([])
});

const DEV_TEST_CONNECTION_DATA_PATH = "/workspace/test-connection-data.json";

export async function bootstrapDevelopmentTestConnectionData(log: { info: (input: unknown, msg?: string) => void; warn: (input: unknown, msg?: string) => void }) {
  if (env.NODE_ENV !== "development") return;

  let raw: string;
  try {
    raw = await readFile(DEV_TEST_CONNECTION_DATA_PATH, "utf8");
  } catch {
    return;
  }

  let parsed: z.infer<typeof testConnectionSchema>;
  try {
    parsed = testConnectionSchema.parse(JSON.parse(raw));
  } catch (error) {
    log.warn({ err: error, path: DEV_TEST_CONNECTION_DATA_PATH }, "failed to parse development test connection data");
    return;
  }

  const current = await getSettings();
  const nzbhydra = parsed.indexers.find((item) => item.name.toLowerCase().includes("nzbhydra")) ?? parsed.indexers[0];
  const tmdb = parsed.media.find((item) => item.name.toLowerCase() === "tmdb");
  const tvdb = parsed.media.find((item) => item.name.toLowerCase() === "tvdb");

  await updateSettings({
    ...current,
    ...(nzbhydra ? { nzbhydraUrl: nzbhydra.host, nzbhydraApiKey: nzbhydra.api_key } : {}),
    ...(tmdb ? { tmdbApiKey: tmdb.api_key } : {}),
    ...(tvdb ? { tvdbApiKey: tvdb.api_key } : {})
  });

  for (const server of parsed["usenet-providers"]) {
    const existing = await prisma.usenetServer.findFirst({ where: { OR: [{ name: server.name }, { host: server.host, port: server.port }] } });
    if (existing) {
      await prisma.usenetServer.update({
        where: { id: existing.id },
        data: {
          name: server.name,
          host: server.host,
          port: server.port,
          ssl: server.ssl,
          username: server.username,
          password: server.password,
          connections: server.connections
        }
      });
    } else {
      await prisma.usenetServer.create({
        data: {
          name: server.name,
          host: server.host,
          port: server.port,
          ssl: server.ssl,
          username: server.username,
          password: server.password,
          connections: server.connections,
          enabled: true
        }
      });
    }
  }

  for (const requester of parsed.requesters) {
    const existing = await prisma.requestProvider.findFirst({ where: { OR: [{ name: requester.name }, { baseUrl: requester.host }] } });
    if (existing) {
      await prisma.requestProvider.update({
        where: { id: existing.id },
        data: {
          type: "seerr",
          name: requester.name,
          baseUrl: requester.host,
          apiKey: requester.api_key
        }
      });
    } else {
      await prisma.requestProvider.create({
        data: {
          type: "seerr",
          name: requester.name,
          baseUrl: requester.host,
          apiKey: requester.api_key,
          enabled: true,
          defaultMovieProfile: current.defaultMovieProfile,
          defaultTvProfile: current.defaultTvProfile
        }
      });
    }
  }

  log.info(
    {
      path: DEV_TEST_CONNECTION_DATA_PATH,
      usenetProviders: parsed["usenet-providers"].length,
      requestProviders: parsed.requesters.length,
      indexers: parsed.indexers.length,
      mediaProviders: parsed.media.length
    },
    "loaded development test connection data"
  );
}
