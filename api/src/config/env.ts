export type AppEnv = {
  databaseUrl: string;
  port: number;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required env var: DATABASE_URL");
  }
  const port = source.PORT ? Number(source.PORT) : 3000;
  if (Number.isNaN(port)) {
    throw new Error(`Invalid PORT: ${source.PORT}`);
  }
  return { databaseUrl, port };
}
