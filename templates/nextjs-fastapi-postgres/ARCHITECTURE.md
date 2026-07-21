# Architecture & shared contracts

This starter is a **working vertical slice** (auth + `items` CRUD) that the
factory's builder agents **extend**. The following contracts are the single
source of truth — keep the backend models, the OpenAPI spec, the SQL schema and
the frontend client in sync when you add features.

## Services

| Service | Dir | Tech | Runs on |
|---------|-----|------|---------|
| Frontend | `web/` | Next.js 15 (App Router, TS) | :3000 |
| Backend | `api/` | FastAPI (Python 3.12) | :8000 |
| Database | — | PostgreSQL 16 (SQLite fallback) | :5432 |

## API contract

- Machine-readable: [`contracts/openapi.yaml`](contracts/openapi.yaml). FastAPI
  also serves the live spec at `/openapi.json` and Swagger UI at `/docs`.
- Auth: OAuth2 password flow. `POST /api/auth/register`, `POST /api/auth/login`
  → `{ access_token, token_type }`. Send `Authorization: Bearer <token>`.
- Resource: `items` — `GET/POST /api/items`, `GET/PATCH/DELETE /api/items/{id}`.
  All item routes are owner-scoped and require auth.
- Ops: `GET /health` (liveness), `GET /ready` (readiness).

## Data model

Canonical model lives in `api/app/models.py`; the equivalent DDL is in
[`contracts/schema.sql`](contracts/schema.sql). Entities: `users`, `items`
(owner-scoped, cascade delete).

## Conventions builders must follow

- Implement strictly against the OpenAPI + SQL contract; do not silently change
  request/response shapes. If a feature needs a contract change, update
  `contracts/openapi.yaml`, `contracts/schema.sql` and the models together.
- Validate all input at the boundary (Pydantic / zod); never log secrets or PII.
- Every new endpoint ships with a test; every new UI view has loading/empty/error
  states.
- Secrets come from env; only `.env.example` placeholders are committed.
- Before production: replace `create_all` on startup with Alembic migrations.

## Run locally

```bash
cp .env.example .env
docker compose up --build
```
