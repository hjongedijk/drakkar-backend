# Backend structure

Backend now uses only these top-level folders inside `src`:

- `src/controllers`
  - Thin HTTP handlers. Parse request, choose response code, call services.
- `src/services`
  - Cross-domain orchestration and domain service entrypoints.
- `src/repositories`
  - Prisma/database access extracted from controllers and shared services.
- `src/models`
  - Shared schemas and request/body/query models.
- `src/routes`
  - Fastify route registration/composition. No business logic.
- `src/middleware`
  - Cross-cutting Fastify hooks like request lifecycle, setup gate, auth.
- `src/workers`
  - Background worker entrypoints and queue processors.
- `src/state-machines`
  - XState machines and actor orchestration.

Rules for next refactors:

- Keep route files thin. Move non-trivial handler bodies into `controllers`.
- Put state-machine code in `state-machines`, not route files.
- Put DB access inside domain services or repositories when query logic grows/repeats.
- Keep request/response validation in `models/schemas`.
- Keep worker startup/queue plumbing in `workers`.
- Do not add new top-level folders under `src`.
