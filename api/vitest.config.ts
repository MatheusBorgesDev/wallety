import { defineConfig } from "vitest/config";

// Local default matches docker-compose.yml; CI overrides it through the environment.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://wallety:wallety@localhost:5433/wallety_test?schema=public";

const purgeUrl = new URL(testDatabaseUrl);
purgeUrl.username = "wallety_purger";
purgeUrl.password = "wallety_purger";
const purgeDatabaseUrl = purgeUrl.toString();

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: testDatabaseUrl,
      // A fixed value for tests only; real environments provide their own secret.
      WEBHOOK_SIGNING_SECRET: "test-signing-secret-with-enough-length",
      JWT_SECRET: "test-jwt-secret-with-enough-length-0123",
      // The cleanup connects with its own login, which can only read and delete.
      PURGE_DATABASE_URL: purgeDatabaseUrl,
      PURGE_SECRET: "test-purge-secret-with-enough-length-01",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts", "src/generated/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          // Integration tests share one database and clean it between tests, so their
          // files must never run at the same time. A VITEST_MAX_WORKERS variable in the
          // environment overrides this option, which is why the npm script sets it too.
          maxWorkers: 1,
        },
      },
    ],
  },
});
