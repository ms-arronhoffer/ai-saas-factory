import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "./auth.js";

// Augment Express Request with the authenticated user id.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = token ? verifyToken(token) : null;
  if (userId === null) {
    res.status(401).json({ error: "Invalid or missing token" });
    return;
  }
  req.userId = userId;
  next();
}
