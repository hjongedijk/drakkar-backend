import type { FastifyInstance } from "fastify";
import { graphql, buildSchema } from "graphql";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { getSettings } from "../settings/settingsStore.js";
import { DRAKKAR_VERSION } from "../version.js";

const schema = buildSchema(`
  type Status {
    appName: String!
    version: String!
    backend: String!
    postgresql: String!
    valkey: String!
  }

  type LibraryItem {
    id: ID!
    mediaType: String!
    title: String!
    year: Int
    season: Int
    episode: Int
    libraryStatus: String!
    streamStatus: String!
    healthStatus: String!
    symlinkPath: String
    filePath: String
    updatedAt: String!
  }

  type Download {
    id: ID!
    title: String!
    source: String!
    status: String!
    progress: Float!
    downloaded: Float!
    size: Float!
    speedBytesSec: Float!
    updatedAt: String!
  }

  type SearchLog {
    id: ID!
    type: String!
    resultCount: Int!
    status: String!
    message: String
    createdAt: String!
  }

  type SettingsSummary {
    nzbhydraConfigured: Boolean!
    usenetConfigured: Boolean!
    requestProvidersConfigured: Boolean!
    plexConfigured: Boolean!
  }

  type Query {
    status: Status!
    library(limit: Int): [LibraryItem!]!
    downloads(limit: Int): [Download!]!
    searchHistory(limit: Int): [SearchLog!]!
    settings: SettingsSummary!
  }
`);

const graphqlBodySchema = z.object({
  query: z.string().min(1),
  variables: z.record(z.unknown()).optional(),
  operationName: z.string().optional()
});

function clampLimit(value: unknown, fallback: number, max: number) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(max, parsed));
}

function serializeDate<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}

export async function graphqlRoutes(app: FastifyInstance): Promise<void> {
  const rootValue = {
    status: async () => {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      return {
        appName: "Drakkar",
        version: DRAKKAR_VERSION,
        backend: "ok",
        postgresql: "ok",
        valkey: "ok"
      };
    },
    library: async ({ limit }: { limit?: number }) => {
      const rows = await prisma.mediaLibraryItem.findMany({
        take: clampLimit(limit, 50, 200),
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          mediaType: true,
          title: true,
          year: true,
          season: true,
          episode: true,
          libraryStatus: true,
          streamStatus: true,
          healthStatus: true,
          symlinkPath: true,
          filePath: true,
          updatedAt: true
        }
      });
      return rows.map(serializeDate);
    },
    downloads: async ({ limit }: { limit?: number }) => {
      const rows = await prisma.download.findMany({
        take: clampLimit(limit, 50, 200),
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          title: true,
          source: true,
          status: true,
          progress: true,
          downloaded: true,
          size: true,
          speedBytesSec: true,
          updatedAt: true
        }
      });
      return rows.map(serializeDate);
    },
    searchHistory: async ({ limit }: { limit?: number }) => {
      const rows = await prisma.searchHistory.findMany({
        take: clampLimit(limit, 50, 200),
        orderBy: [{ createdAt: "desc" }],
        select: { id: true, type: true, resultCount: true, status: true, message: true, createdAt: true }
      });
      return rows.map(serializeDate);
    },
    settings: async () => {
      const [settings, usenetServers, requestProviders] = await Promise.all([
        getSettings(),
        prisma.usenetServer.count({ where: { enabled: true } }),
        prisma.requestProvider.count({ where: { enabled: true } })
      ]);
      return {
        nzbhydraConfigured: Boolean(settings.nzbhydraUrl && settings.nzbhydraApiKey),
        usenetConfigured: usenetServers > 0,
        requestProvidersConfigured: requestProviders > 0,
        plexConfigured: Boolean(settings.plexServerUrl && settings.plexToken)
      };
    }
  };

  app.post("/api/graphql", async (request, reply) => {
    const body = graphqlBodySchema.parse(request.body ?? {});
    const result = await graphql({
      schema,
      source: body.query,
      rootValue,
      variableValues: body.variables,
      operationName: body.operationName
    });
    if (result.errors?.length) reply.status(400);
    return result;
  });

  app.get("/api/graphql", async (_request, reply) => {
    reply.type("text/html");
    return `<!doctype html>
<html>
  <head>
    <title>Drakkar GraphQL</title>
    <link rel="stylesheet" href="https://unpkg.com/graphiql@2/graphiql.min.css" />
    <style>html,body,#graphiql{height:100%;margin:0;background:#061012;color:#e7fbff}</style>
  </head>
  <body>
    <div id="graphiql">Loading GraphiQL...</div>
    <script src="/config.js"></script>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/graphiql@2/graphiql.min.js"></script>
    <script>
      const defaultQuery = '{\\n  status { version backend postgresql valkey }\\n  downloads(limit: 5) { title status progress }\\n}';
      const fetcher = GraphiQL.createFetcher({
        url: '/api/graphql',
        headers: {
          'content-type': 'application/json',
          'x-api-token': window.__DRAKKAR_CONFIG__?.FRONTEND_API_TOKEN || ''
        },
        credentials: 'include'
      });
      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, { fetcher, defaultQuery })
      );
    </script>
  </body>
</html>`;
  });
}
