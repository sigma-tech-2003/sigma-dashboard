import { createApp } from "./app.js";
import { environment } from "./config/env.js";

const app = createApp();

app.listen(environment.port, () => {
  console.info(`Sigma HRM API listening on port ${environment.port}.`);
});
