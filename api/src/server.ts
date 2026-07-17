import { app } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
app.listen(env.port, () => {
  console.log(`API listening on port ${env.port}`);
});
