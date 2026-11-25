import { defineConfig, env } from "prisma/config";

// Prisma 7 no longer loads .env files on its own. Load the local one when it
// exists; in CI and production the variables come from the environment.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the process environment.
}

type Env = {
  DATABASE_URL: string;
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env<Env>("DATABASE_URL"),
  },
});
