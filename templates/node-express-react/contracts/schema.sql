-- Canonical schema mirror for the node/express slice. The Prisma schema at
-- api/prisma/schema.prisma is authoritative. DDL shown for PostgreSQL (scale).

CREATE TABLE IF NOT EXISTS "User" (
    id              SERIAL PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    "hashedPassword" TEXT NOT NULL,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Item" (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    "ownerId"   INTEGER NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Item_ownerId_idx" ON "Item" ("ownerId");
