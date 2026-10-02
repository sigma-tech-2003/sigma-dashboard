import { createApp } from "./app.js";
import { environment, getCompanyTimezone } from "./config/env.js";

// Fail at boot, not on the first attendance request: a missing or invalid COMPANY_TIMEZONE
// would otherwise only surface when the container is first built.
getCompanyTimezone();

const app = createApp();

app.listen(environment.port, () => {
  console.info(`Sigma HRM API listening on port ${environment.port}.`);
});
