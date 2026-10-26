// Attendance figures for the dashboards: one latest record per person per day, summarised. Moved out of the dashboard
// page unchanged so the page can be rebuilt without touching the arithmetic.

export const normalizeAttendanceStatus = (status) => {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return normalized === "on leave" ? "leave" : normalized;
};

export const attendanceDateValue = (value) => {
  if (typeof value === "string") {
    const dateValue = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (dateValue) return dateValue;
  }

  if (!value) return "";
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
};

export const attendanceRecordTimestamp = (record) => {
  for (const value of [record?.updatedAt, record?.createdAt]) {
    if (!value) continue;
    if (typeof value?.toMillis === "function") {
      const timestamp = value.toMillis();
      if (Number.isFinite(timestamp)) return timestamp;
    }
    const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
    const timestamp = date.getTime();
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
};

export const latestAttendanceRecords = (records, employeeIds, date = "") => {
  const targetDate = date ? attendanceDateValue(date) : "";
  const latestByEmployeeDate = new Map();

  (Array.isArray(records) ? records : []).forEach((record) => {
    if (!record || typeof record !== "object" || record.empId == null) return;
    const employeeId = String(record.empId);
    const recordDate = attendanceDateValue(record.date);
    if (!employeeIds.has(employeeId) || !recordDate || (targetDate && recordDate !== targetDate)) return;

    const key = `${employeeId}:${recordDate}`;
    const current = latestByEmployeeDate.get(key);
    if (!current || attendanceRecordTimestamp(record) >= attendanceRecordTimestamp(current)) {
      latestByEmployeeDate.set(key, record);
    }
  });

  return [...latestByEmployeeDate.values()];
};

export const getAttendanceSummary = (scopedEmployees, attendanceRecords, date) => {
  const activeEmployeeIds = new Set(
    (Array.isArray(scopedEmployees) ? scopedEmployees : [])
      .filter(employee =>
        employee
        && typeof employee === "object"
        && employee.id != null
        && normalizeAttendanceStatus(employee.status) === "active",
      )
      .map(employee => String(employee.id)),
  );
  const summary = {
    present: 0,
    late: 0,
    absent: 0,
    leave: 0,
    marked: 0,
    unmarked: activeEmployeeIds.size,
    total: activeEmployeeIds.size,
    attended: 0,
  };
  if (!attendanceDateValue(date)) return summary;

  latestAttendanceRecords(attendanceRecords, activeEmployeeIds, date).forEach((record) => {
    const status = normalizeAttendanceStatus(record.status);
    if (!["present", "late", "absent", "leave"].includes(status)) return;
    summary[status] += 1;
    summary.marked += 1;
  });

  summary.attended = summary.present + summary.late;
  summary.unmarked = Math.max(0, summary.total - summary.marked);
  return summary;
};

export const getEmployeeAttendanceRate = (employeeId, attendanceRecords) => {
  if (employeeId == null) return { percentage: null, attended: 0, total: 0 };
  const employeeIds = new Set([String(employeeId)]);
  const eligibleStatuses = latestAttendanceRecords(attendanceRecords, employeeIds)
    .map(record => normalizeAttendanceStatus(record.status))
    .filter(status => ["present", "late", "absent"].includes(status));
  if (eligibleStatuses.length === 0) return { percentage: null, attended: 0, total: 0 };

  const attended = eligibleStatuses.filter(status => status === "present" || status === "late").length;
  return {
    percentage: Math.round((attended / eligibleStatuses.length) * 100),
    attended,
    total: eligibleStatuses.length,
  };
};

export const attendanceSummaryLabel = (summary) =>
  `${summary.marked} marked · ${summary.unmarked} unmarked · ${summary.late} late`;
