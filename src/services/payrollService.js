import * as mapper from "./mappers/payroll.js";
import { createResourceService } from "./resourceService.js";
import { api as defaultApi } from "./apiClient.js";

export const createPayrollService = (api = defaultApi) => createResourceService({ path: "/payroll", mapper, api });

export const payrollService = createPayrollService();
