import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";

const app = createApp();

async function authHeader(): Promise<{ Authorization: string }> {
  await request(app).post("/api/auth/register").send({ email: "u@example.com", password: "password123" });
  const res = await request(app).post("/api/auth/login").send({ email: "u@example.com", password: "password123" });
  return { Authorization: `Bearer ${res.body.access_token}` };
}

describe("api", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reports health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("requires auth for items", async () => {
    const res = await request(app).get("/api/items");
    expect(res.status).toBe(401);
  });

  it("supports the item CRUD lifecycle", async () => {
    const headers = await authHeader();
    const created = await request(app).post("/api/items").set(headers).send({ title: "First" });
    expect(created.status).toBe(201);

    const list = await request(app).get("/api/items").set(headers);
    expect(list.body).toHaveLength(1);

    const updated = await request(app).patch(`/api/items/${created.body.id}`).set(headers).send({ title: "Renamed" });
    expect(updated.body.title).toBe("Renamed");

    const del = await request(app).delete(`/api/items/${created.body.id}`).set(headers);
    expect(del.status).toBe(204);
  });
});
