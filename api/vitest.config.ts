import { defineConfig } from "vitest/config";

// Local default matches docker-compose.yml; CI overrides it through the environment.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://wallety:wallety@localhost:5433/wallety_test?schema=public";

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDatabaseUrl },
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
