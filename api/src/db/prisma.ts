import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { loadEnv } from "../config/env.js";

// Prisma 7 talks to Postgres through a driver adapter. The pool connects
// lazily, so importing this module does not open a connection.
const adapter = new PrismaPg({ connectionString: loadEnv().databaseUrl });

export const prisma = new PrismaClient({ adapter });
