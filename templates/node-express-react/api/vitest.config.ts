import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Zero-infra test DB; globalSetup runs `prisma db push` against it.
    env: { DATABASE_URL: "file:./test.db", JWT_SECRET: "test-secret" },
    globalSetup: "./test/globalSetup.ts",
    pool: "forks",
  },
});
