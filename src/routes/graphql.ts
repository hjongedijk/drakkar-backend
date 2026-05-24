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

  app.get("/api/docs", async (_request, reply) => {
    reply.type("text/html");
    return `<!doctype html>
<html>
  <head>
    <title>Drakkar API Docs</title>
    <style>
      :root{color-scheme:dark}
      *{box-sizing:border-box}
      body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#071014;color:#e8fbff}
      main{max-width:1100px;margin:0 auto;padding:40px 24px 64px}
      h1,h2,h3{margin:0 0 12px}
      p{line-height:1.6;color:#abd1d8}
      .hero{padding:28px;border:1px solid rgba(84,221,201,.24);border-radius:24px;background:linear-gradient(180deg,rgba(18,38,44,.92),rgba(8,18,21,.96))}
      .grid{display:grid;gap:18px}
      .cards{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
      .card{padding:18px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03)}
      code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      code{background:rgba(255,255,255,.07);padding:2px 6px;border-radius:8px;color:#bffaf2}
      pre{overflow:auto;padding:16px;border-radius:16px;background:#031014;border:1px solid rgba(255,255,255,.08);color:#d9fcff}
      a{color:#4cead1;text-decoration:none}
      a:hover{text-decoration:underline}
      .pill{display:inline-block;margin-right:8px;margin-bottom:8px;padding:6px 10px;border-radius:999px;background:rgba(76,234,209,.12);color:#78f4df;font-size:12px;font-weight:700}
      .muted{color:#86aeb5}
    </style>
  </head>
  <body>
    <main class="grid">
      <section class="hero">
        <h1>Drakkar API Docs</h1>
        <p>Drakkar exposes a browser-friendly GraphQL explorer and an authenticated REST API. The shared <code>Drakkar API Token</code> from <code>settings.json</code> can be used as both the frontend gateway token and the bearer token for admin API access.</p>
        <div style="margin-top:16px">
          <a class="pill" href="/api/graphql">Open GraphiQL</a>
          <span class="pill">Version ${DRAKKAR_VERSION}</span>
        </div>
      </section>

      <section class="grid cards">
        <article class="card">
          <h2>Authentication</h2>
          <p>Use the same token twice for remote admin access:</p>
<pre>curl -H 'x-api-token: YOUR_DRAKKAR_API_TOKEN' \\
  -H 'Authorization: Bearer YOUR_DRAKKAR_API_TOKEN' \\
  http://HOST:8080/api/status</pre>
          <p class="muted">Browser sessions can also authenticate with login cookies.</p>
        </article>

        <article class="card">
          <h2>GraphQL</h2>
          <p>Use <a href="/api/graphql">GraphiQL</a> for interactive exploration.</p>
<pre>{
  status { version backend postgresql valkey }
  downloads(limit: 5) { title status progress }
  library(limit: 5) { title mediaType libraryStatus updatedAt }
}</pre>
        </article>

        <article class="card">
          <h2>Key REST endpoints</h2>
          <p><code>GET /api/status</code> overall service state</p>
          <p><code>GET /api/library</code> media library items</p>
          <p><code>GET /api/requests</code> monitored requests</p>
          <p><code>POST /api/webhooks/seerr</code> immediate Seerr request push</p>
          <p><code>GET /api/downloads/queue/page</code> queue page</p>
          <p><code>GET /api/tasks</code> scheduled task state</p>
        </article>
      </section>

      <section class="card">
        <h2>Examples</h2>
<pre>curl -H 'x-api-token: YOUR_DRAKKAR_API_TOKEN' \\
  -H 'Authorization: Bearer YOUR_DRAKKAR_API_TOKEN' \\
  http://HOST:8080/api/requests

curl -H 'x-api-token: YOUR_DRAKKAR_API_TOKEN' \\
  -H 'Authorization: Bearer YOUR_DRAKKAR_API_TOKEN' \\
  'http://HOST:8080/api/downloads/queue/page?page=1&limit=25'

curl -H 'x-api-token: YOUR_DRAKKAR_API_TOKEN' \\
  -H 'Authorization: Bearer YOUR_DRAKKAR_API_TOKEN' \\
  http://HOST:8080/api/tasks

curl -X POST \\
  -H 'Authorization: Bearer YOUR_DRAKKAR_API_TOKEN' \\
  -H 'content-type: application/json' \\
  http://HOST:8080/api/webhooks/seerr \\
  -d '{"notification_type":"MEDIA_AUTO_APPROVED","event":"Request Automatically Approved","request":{"request_id":"1234"},"media":{"tmdbId":"1399","tvdbId":"121361","imdbId":"tt0944947"}}'

# Webhook-origin requests are promoted to the front of the waiting queue,
# but the active download is not interrupted.</pre>
      </section>
    </main>
  </body>
</html>`;
  });
}
