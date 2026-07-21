# Architecture & shared contract (API-only)

A **working vertical slice** — JWT auth + an owner-scoped `items` CRUD — that the
factory's builder agents extend. The FastAPI app lives at the repository root
(`app/`).

## Contract

- Machine-readable: [`contracts/openapi.yaml`](contracts/openapi.yaml). FastAPI
  also serves the live spec at `/openapi.json` and Swagger UI at `/docs`.
- Auth: OAuth2 password flow — `POST /api/auth/register`, `POST /api/auth/login`
  → `{ access_token, token_type }`; send `Authorization: Bearer <token>`.
- Resource: `items` — `GET/POST /api/items`, `GET/PATCH/DELETE /api/items/{id}`,
  all owner-scoped and auth-required.
- Ops: `GET /health`, `GET /ready`.

## Data model

Canonical model in `app/models.py`; DDL mirror in
[`contracts/schema.sql`](contracts/schema.sql). Entities: `users`, `items`.

## Conventions builders must follow

- Implement strictly against the OpenAPI + SQL contract; change them together
  when a feature requires it.
- Validate input at the boundary (Pydantic); never log secrets or PII.
- Every new endpoint ships with a test.
- Secrets from env; only `.env.example` placeholders are committed.
- Before production: replace `create_all` on startup with Alembic migrations.
