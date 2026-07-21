import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { createToken, hashPassword, verifyPassword } from "../auth.js";

export const authRouter = Router();

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

authRouter.post("/register", async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) return res.status(409).json({ error: "Email already registered" });
  const user = await prisma.user.create({
    data: { email: parsed.data.email, hashedPassword: hashPassword(parsed.data.password) },
  });
  return res.status(201).json({ id: user.id, email: user.email, createdAt: user.createdAt });
});

authRouter.post("/login", async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !verifyPassword(parsed.data.password, user.hashedPassword)) {
    return res.status(401).json({ error: "Incorrect email or password" });
  }
  return res.json({ access_token: createToken(user.id), token_type: "bearer" });
});
