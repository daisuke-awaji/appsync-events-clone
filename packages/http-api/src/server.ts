import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { getEnv } from "./env.js";

const app = createApp();
const port = getEnv().PORT;

console.log(JSON.stringify({ level: "info", msg: "starting http-api", port }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ level: "info", msg: "http-api listening", port: info.port }));
});
