import * as mapper from "./mappers/attendance.js";
import { createResourceService } from "./resourceService.js";
import { api as defaultApi } from "./apiClient.js";

export const createAttendanceService = (api = defaultApi) => createResourceService({ path: "/attendance", mapper, api });

export const attendanceService = createAttendanceService();
