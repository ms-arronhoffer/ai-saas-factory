import cors from "cors";
import express, { type Express } from "express";
import { authRouter } from "./routes/auth.js";
import { itemsRouter } from "./routes/items.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(
    cors({
      origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()),
      credentials: true,
    }),
  );

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.json({ status: "ready" }));
  app.use("/api/auth", authRouter);
  app.use("/api/items", itemsRouter);

  return app;
}
