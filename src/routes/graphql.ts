import type { FastifyInstance } from "fastify";
import { graphql, buildSchema } from "graphql";
import { z } from "zod";
import { prisma } from "../repositories/db/prisma.js";
import { redis } from "../repositories/db/redis.js";
import { getSettings } from "../services/settings/settingsStore.js";
import { DRAKKAR_VERSION } from "../models/version.js";

const schema = buildSchema(`
  """Basic runtime health for Drakkar and core infrastructure."""
  type Status {
    """Human-facing application name."""
    appName: String!
    """Current backend version."""
    version: String!
    """Backend process health."""
    backend: String!
    """PostgreSQL connectivity health."""
    postgresql: String!
    """Valkey/Redis connectivity health."""
    valkey: String!
  }

  """Authenticated Drakkar user."""
  type AuthUser {
    """Stable internal user id."""
    id: ID!
    """Login username."""
    username: String!
    """Display name used in the UI."""
    displayName: String!
    """Whether this user has admin access."""
    isAdmin: Boolean!
    """Whether the user should change the password after the next login."""
    mustChangePassword: Boolean!
  }

  """Projected library row as shown by the Drakkar library UI."""
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

  """Download queue or history row."""
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

  """Stored search/log history row."""
  type SearchLog {
    id: ID!
    type: String!
    resultCount: Int!
    status: String!
    message: String
    createdAt: String!
  }

  """Boolean summary of whether major integrations are configured."""
  type SettingsSummary {
    nzbhydraConfigured: Boolean!
    usenetConfigured: Boolean!
    requestProvidersConfigured: Boolean!
    plexConfigured: Boolean!
  }

  type Query {
    """Current authenticated Drakkar user resolved from session cookie or bearer token."""
    me: AuthUser!
    """Lightweight service/runtime health summary."""
    status: Status!
    """Latest library rows. Use \`limit\` to cap result size."""
    library(limit: Int): [LibraryItem!]!
    """Latest downloads ordered by update time. Use \`limit\` to cap result size."""
    downloads(limit: Int): [Download!]!
    """Latest search/log history rows. Use \`limit\` to cap result size."""
    searchHistory(limit: Int): [SearchLog!]!
    """Whether major integrations are configured at all."""
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

function serializeScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Drakkar API",
      version: DRAKKAR_VERSION,
      description: "Drakkar REST and GraphQL API. Browser users can rely on the normal Drakkar login session cookie. Scripts can use the Drakkar API token as `x-api-token`, and for protected routes also as `Authorization: Bearer <token>`."
    },
    servers: [
      { url: "/", description: "Current host via frontend proxy or direct backend" }
    ],
    tags: [
      { name: "Status", description: "Service health, diagnostics, and low-level runtime information." },
      { name: "Auth", description: "Login, session, and API token management." },
      { name: "Downloads", description: "Queue, history, add/retry/cancel downloads, and NZB URL checks." },
      { name: "Requests", description: "Seerr sync, request monitoring, ranking, and grabs." },
      { name: "Library", description: "Library listing, refresh, replacement, and reimport operations." },
      { name: "Tasks", description: "Scheduled task status and manual task execution." },
      { name: "Calendar", description: "Release calendar for movies, shows, and episodes." },
      { name: "GraphQL", description: "Schema explorer and GraphQL POST endpoint." },
      { name: "Settings", description: "Runtime settings and Drakkar API token management." },
      { name: "Webhooks", description: "Inbound provider webhook endpoints." }
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "usenet_vfs_session",
          description: "Normal Drakkar browser login session cookie."
        },
        apiTokenHeader: {
          type: "apiKey",
          in: "header",
          name: "x-api-token",
          description: "Drakkar API token for script and service access."
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Token",
          description: "Use the same Drakkar API token as bearer auth for admin API access."
        }
      },
      schemas: {
        ApiStatus: {
          type: "object",
          properties: {
            appName: { type: "string" },
            version: { type: "string" },
            backend: { type: "string" },
            postgresql: { type: "string" },
            valkey: { type: "string" },
            nzbhydra: { type: "string" },
            seerr: { type: "string" },
            activeDownloads: { type: "integer" },
            queueSize: { type: "integer" }
          }
        },
        QueueCounts: {
          type: "object",
          additionalProperties: { type: "integer" }
        },
        Download: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            source: { type: "string" },
            status: { type: "string" },
            statusLabel: { type: "string" },
            progress: { type: "number" },
            size: { type: "number" },
            downloaded: { type: "number" },
            speedBytesSec: { type: "number" },
            etaSeconds: { type: ["integer", "null"] },
            error: { type: ["string", "null"] }
          }
        },
        DownloadPage: {
          type: "object",
          properties: {
            items: { type: "array", items: { $ref: "#/components/schemas/Download" } },
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
            totalPages: { type: "integer" }
          }
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            status: { type: "string" },
            enabled: { type: "boolean" },
            manualRunnable: { type: "boolean" },
            intervalMs: { type: ["integer", "null"] },
            lastStartedAt: { type: ["string", "null"], format: "date-time" },
            lastCompletedAt: { type: ["string", "null"], format: "date-time" },
            nextRunAt: { type: ["string", "null"], format: "date-time" },
            lastError: { type: ["string", "null"] }
          }
        },
        ReleaseCalendarEntry: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["movie", "show", "episode"] },
            title: { type: "string" },
            releaseDate: { type: "string", format: "date" },
            overview: { type: "string" },
            mediaType: { type: "string", enum: ["movie", "tv"] },
            year: { type: "integer" },
            tmdbId: { type: "string" },
            tvdbId: { type: "string" },
            imdbId: { type: "string" },
            seriesTitle: { type: "string" },
            seasonNumber: { type: "integer" },
            episodeNumber: { type: "integer" }
          }
        },
        RequestProvider: {
          type: "object",
          properties: {
            type: { type: "string", example: "seerr" },
            name: { type: "string" },
            baseUrl: { type: "string", format: "uri" },
            apiKey: { type: "string" },
            enabled: { type: "boolean" },
            syncIntervalMinutes: { type: "integer" },
            defaultMovieProfile: { type: "string" },
            defaultTvProfile: { type: "string" }
          },
          required: ["name", "baseUrl", "apiKey"]
        },
        AddUrlInput: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            title: { type: "string" }
          },
          required: ["url"]
        },
        AddNzbInput: {
          type: "object",
          properties: {
            filename: { type: "string" },
            title: { type: "string" },
            content: { type: "string", description: "NZB XML text content." },
            category: { type: "string" }
          },
          required: ["content"]
        },
        GraphqlBody: {
          type: "object",
          properties: {
            query: { type: "string" },
            variables: { type: "object", additionalProperties: true },
            operationName: { type: "string" }
          },
          required: ["query"]
        },
        DrakkarApiTokenState: {
          type: "object",
          properties: {
            drakkarApiToken: { type: "string" }
          },
          required: ["drakkarApiToken"]
        }
      }
    },
    security: [{ apiTokenHeader: [], bearerAuth: [] }],
    paths: {
      "/api/status": {
        get: {
          tags: ["Status"],
          summary: "Runtime service status",
          responses: {
            "200": {
              description: "Current runtime status",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ApiStatus" } } }
            }
          }
        }
      },
      "/api/diagnostics": {
        get: {
          tags: ["Status"],
          summary: "Queue and policy diagnostics",
          responses: {
            "200": {
              description: "Low-level runtime diagnostics"
            }
          }
        }
      },
      "/api/debug/usenet": {
        get: {
          tags: ["Status"],
          summary: "Usenet provider and pool debug state",
          responses: { "200": { description: "Usenet debug state" } }
        }
      },
      "/api/downloads/queue": {
        get: {
          tags: ["Downloads"],
          summary: "Download queue summary",
          responses: { "200": { description: "Queue items", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Download" } } } } } }
        }
      },
      "/api/downloads/queue/page": {
        get: {
          tags: ["Downloads"],
          summary: "Paginated download queue",
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } }
          ],
          responses: { "200": { description: "Paginated queue", content: { "application/json": { schema: { $ref: "#/components/schemas/DownloadPage" } } } } }
        }
      },
      "/api/downloads/history/page": {
        get: {
          tags: ["Downloads"],
          summary: "Paginated download history",
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } }
          ],
          responses: { "200": { description: "Paginated history" } }
        }
      },
      "/api/downloads/add-url": {
        post: {
          tags: ["Downloads"],
          summary: "Queue an NZB by URL",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AddUrlInput" } } }
          },
          responses: { "200": { description: "Queued download", content: { "application/json": { schema: { $ref: "#/components/schemas/Download" } } } } }
        }
      },
      "/api/downloads/add-nzb": {
        post: {
          tags: ["Downloads"],
          summary: "Upload and queue raw NZB XML",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AddNzbInput" } } }
          },
          responses: { "200": { description: "Queued download" } }
        }
      },
      "/api/downloads/test-nzb-url": {
        post: {
          tags: ["Downloads"],
          summary: "Test an NZB URL without committing it",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AddUrlInput" } } }
          },
          responses: { "200": { description: "NZB URL validation result" } }
        }
      },
      "/api/requests": {
        get: {
          tags: ["Requests"],
          summary: "List synced/manual requests",
          responses: { "200": { description: "Request list" } }
        },
        post: {
          tags: ["Requests"],
          summary: "Create manual movie or TV request",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    mediaType: { type: "string", enum: ["movie", "tv"] },
                    title: { type: "string" },
                    year: { type: "integer" },
                    tmdbId: { type: "string" },
                    tvdbId: { type: "string" },
                    imdbId: { type: "string" }
                  },
                  required: ["mediaType", "title"]
                }
              }
            }
          },
          responses: { "200": { description: "Created request" } }
        }
      },
      "/api/requests/sync": {
        post: {
          tags: ["Requests"],
          summary: "Run Seerr sync now",
          responses: { "200": { description: "Sync result" } }
        }
      },
      "/api/request-providers": {
        get: {
          tags: ["Requests"],
          summary: "List request providers",
          responses: { "200": { description: "Provider list" } }
        },
        post: {
          tags: ["Requests"],
          summary: "Create request provider",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RequestProvider" } } }
          },
          responses: { "200": { description: "Created provider" } }
        }
      },
      "/api/webhooks/seerr": {
        post: {
          tags: ["Webhooks"],
          summary: "Receive Seerr webhook events",
          description: "Seerr test payloads and non-request events return success without forcing a full sync. Real request events with `request.request_id` trigger targeted sync and queue promotion.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: true
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Webhook accepted"
            }
          }
        }
      },
      "/api/library": {
        get: {
          tags: ["Library"],
          summary: "List library items",
          responses: { "200": { description: "Library items" } }
        }
      },
      "/api/library/stats": {
        get: {
          tags: ["Library"],
          summary: "Library status counts",
          responses: { "200": { description: "Library statistics" } }
        }
      },
      "/api/library/refresh": {
        post: {
          tags: ["Library"],
          summary: "Refresh library projection",
          responses: { "200": { description: "Library refresh result" } }
        }
      },
      "/api/tasks": {
        get: {
          tags: ["Tasks"],
          summary: "List scheduled/manual tasks",
          responses: {
            "200": {
              description: "Task list",
              content: { "application/json": { schema: { type: "object", properties: { tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } } } } } }
            }
          }
        }
      },
      "/api/tasks/{id}/run": {
        post: {
          tags: ["Tasks"],
          summary: "Queue a manual task for background execution",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Task was already running" },
            "202": { description: "Task accepted for background execution" }
          }
        }
      },
      "/api/release-calendar": {
        get: {
          tags: ["Calendar"],
          summary: "Get release calendar month data",
          parameters: [
            { name: "month", in: "query", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$", example: "2026-05" } }
          ],
          responses: {
            "200": {
              description: "Calendar month",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      month: { type: "string" },
                      startsOn: { type: "string", format: "date" },
                      endsOn: { type: "string", format: "date" },
                      entries: { type: "array", items: { $ref: "#/components/schemas/ReleaseCalendarEntry" } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/settings/drakkar-api-token": {
        get: {
          tags: ["Settings"],
          summary: "Read the Drakkar API token",
          responses: { "200": { description: "Drakkar API token state", content: { "application/json": { schema: { $ref: "#/components/schemas/DrakkarApiTokenState" } } } } }
        }
      },
      "/api/settings/drakkar-api-token/rotate": {
        post: {
          tags: ["Settings"],
          summary: "Rotate the Drakkar API token",
          responses: { "200": { description: "New token", content: { "application/json": { schema: { $ref: "#/components/schemas/DrakkarApiTokenState" } } } } }
        }
      },
      "/api/graphql": {
        get: {
          tags: ["GraphQL"],
          summary: "GraphiQL 2 explorer",
          responses: { "200": { description: "GraphiQL HTML" } }
        },
        post: {
          tags: ["GraphQL"],
          summary: "Run GraphQL query",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/GraphqlBody" } } }
          },
          responses: { "200": { description: "GraphQL response" }, "400": { description: "GraphQL validation/execution error" } }
        }
      }
    }
  };
}

export async function graphqlRoutes(app: FastifyInstance): Promise<void> {
  const rootValue = {
    me: (_args: unknown, context: { authUser?: { id: string; username: string; displayName?: string | null; isAdmin: boolean; mustChangePassword: boolean } }) => ({
      id: context.authUser?.id ?? "",
      username: context.authUser?.username ?? "",
      displayName: context.authUser?.displayName ?? context.authUser?.username ?? "",
      isAdmin: Boolean(context.authUser?.isAdmin),
      mustChangePassword: Boolean(context.authUser?.mustChangePassword)
    }),
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
      operationName: body.operationName,
      contextValue: { authUser: request.authUser }
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
    <style>html,body,#graphiql{height:100%;margin:0}</style>
  </head>
  <body>
    <div id="graphiql">Loading GraphiQL...</div>
    <script src="/config.js"></script>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/graphiql@2/graphiql.min.js"></script>
    <script>
      const token = window.__DRAKKAR_CONFIG__?.DRAKKAR_API_TOKEN || window.__DRAKKAR_CONFIG__?.FRONTEND_API_TOKEN || '';
      const defaultQuery = '# Auth uses the Drakkar API token.\\nquery DashboardPreview {\\n  me { username displayName isAdmin }\\n  status { appName version backend postgresql valkey }\\n  downloads(limit: 5) { title status progress speedBytesSec }\\n  library(limit: 5) { title mediaType libraryStatus streamStatus updatedAt }\\n  settings { nzbhydraConfigured usenetConfigured requestProvidersConfigured plexConfigured }\\n}';
      const fetcher = GraphiQL.createFetcher({
        url: '/api/graphql',
        headers: {
          'content-type': 'application/json',
          'x-api-token': token,
          'authorization': token ? 'Bearer ' + token : ''
        },
        credentials: 'include'
      });
      const header = React.createElement('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          padding: '10px 14px',
          borderBottom: '1px solid rgba(15,23,42,.12)',
          background: '#f8fafc',
          color: '#0f172a',
          fontFamily: 'ui-sans-serif,system-ui,sans-serif',
          fontSize: '13px'
        }
      }, [
        React.createElement('div', { key: 'left' }, 'Drakkar GraphQL: same auth as the app. Session cookie works; token auth also works.'),
        React.createElement('a', { key: 'right', href: '/api/docs', style: { color: '#0f766e', textDecoration: 'none', fontWeight: 600 } }, 'Open API Reference')
      ]);
      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(React.Fragment, null, [
          header,
          React.createElement('div', { key: 'graphiql-shell', style: { height: 'calc(100% - 46px)' } },
            React.createElement(GraphiQL, { fetcher, defaultQuery })
          )
        ])
      );
    </script>
  </body>
</html>`;
  });

  app.get("/api/openapi.json", async () => openApiDocument());

  app.get("/api/docs", async (_request, reply) => {
    const document = serializeScriptJson(openApiDocument());
    reply.type("text/html");
    return `<!doctype html>
<html>
  <head>
    <title>Drakkar API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body, #app { margin: 0; min-height: 100%; background: #0b1220; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.57.5"></script>
    <script>
      const content = ${document};
      Scalar.createApiReference('#app', {
        content,
        layout: 'modern',
        theme: 'saturn',
        pageTitle: 'Drakkar API Reference',
        hideDownloadButton: false,
        withDefaultFonts: true,
        darkMode: false,
        authentication: {
          preferredSecurityScheme: ['sessionCookie', 'apiTokenHeader', 'bearerAuth']
        },
        customCss: \`
          .light-mode { --scalar-color-1: #0f172a; --scalar-background-1: #f8fafc; }
          .scalar-api-reference { min-height: 100vh; }
        \`,
        fetch: (input, init) => {
          return window.fetch(input, {
            ...init,
            credentials: 'include',
            headers: {
              ...(init?.headers || {})
            }
          })
        },
        onLoaded: () => {
          document.title = 'Drakkar API Reference'
        }
      });
    </script>
  </body>
</html>`;
  });
}
