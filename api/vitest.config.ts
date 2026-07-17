import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        "postgresql://wallety:wallety@localhost:5433/wallety_test?schema=public",
    },
  },
});
