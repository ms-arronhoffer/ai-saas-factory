import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware.js";

export const itemsRouter = Router();
itemsRouter.use(requireAuth);

const createSchema = z.object({ title: z.string().min(1).max(200), description: z.string().max(5000).optional() });
const updateSchema = z.object({ title: z.string().min(1).max(200).optional(), description: z.string().max(5000).optional() });

itemsRouter.get("/", async (req, res) => {
  const items = await prisma.item.findMany({ where: { ownerId: req.userId }, orderBy: { createdAt: "desc" } });
  res.json(items);
});

itemsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.item.create({
    data: { title: parsed.data.title, description: parsed.data.description ?? "", ownerId: req.userId! },
  });
  return res.status(201).json(item);
});

async function findOwned(id: number, userId: number) {
  const item = await prisma.item.findUnique({ where: { id } });
  return item && item.ownerId === userId ? item : null;
}

itemsRouter.get("/:id", async (req, res) => {
  const item = await findOwned(Number(req.params.id), req.userId!);
  if (!item) return res.status(404).json({ error: "Item not found" });
  return res.json(item);
});

itemsRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = await findOwned(Number(req.params.id), req.userId!);
  if (!existing) return res.status(404).json({ error: "Item not found" });
  const item = await prisma.item.update({ where: { id: existing.id }, data: parsed.data });
  return res.json(item);
});

itemsRouter.delete("/:id", async (req, res) => {
  const existing = await findOwned(Number(req.params.id), req.userId!);
  if (!existing) return res.status(404).json({ error: "Item not found" });
  await prisma.item.delete({ where: { id: existing.id } });
  return res.status(204).send();
});
