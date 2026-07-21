import { PrismaClient } from "@prisma/client";

// Single shared Prisma client. DATABASE_URL controls the target database.
export const prisma = new PrismaClient();
