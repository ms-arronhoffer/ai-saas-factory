import { execSync } from "node:child_process";

// Create the SQLite test schema before the suite runs.
export default function setup() {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  });
}
