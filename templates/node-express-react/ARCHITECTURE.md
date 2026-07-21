# Architecture & shared contracts

A **working vertical slice** (JWT auth + owner-scoped `items` CRUD) that the
factory's builder agents extend.

## Services

| Service | Dir | Tech | Runs on |
|---------|-----|------|---------|
| Frontend | `web/` | React 18 + Vite (TS) | :3000 |
| Backend | `api/` | Express + Prisma (TS) | :8000 |
| Database | — | SQLite (dev) → PostgreSQL (scale) | file / :5432 |

## API contract

- Machine-readable: [`contracts/openapi.yaml`](contracts/openapi.yaml).
- Auth: `POST /api/auth/register`, `POST /api/auth/login` → `{ access_token }`.
  Send `Authorization: Bearer <token>`.
- Resource: `items` — `GET/POST /api/items`, `GET/PATCH/DELETE /api/items/{id}`,
  all owner-scoped and auth-required.
- Ops: `GET /health`, `GET /ready`.

## Data model

Canonical model in `api/prisma/schema.prisma`; SQL mirror in
[`contracts/schema.sql`](contracts/schema.sql). Entities: `User`, `Item`.

## Conventions builders must follow

- Implement strictly against the OpenAPI + Prisma schema; change them together.
- Validate input with zod at the boundary; never log secrets or PII.
- Every new route ships with a test; every UI view has loading/empty/error states.
- Secrets from env; only `.env.example` placeholders committed.
- For growth/scale: switch the Prisma datasource provider to `postgresql`, add a
  managed Postgres service, and use `prisma migrate` instead of `db push`.
