import { useRef, useState } from "react";
import {
  CalendarCheck2,
  CalendarDays,
  Check,
  CircleDashed,
  Clock3,
  Pencil,
  Plus,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";

import {
  Badge,
  Btn,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FilterBar,
  FormFeedback,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SearchBar,
  Select,
  Textarea,
} from "../../components";
import Stat from "../../components/stat/Stat";
import LoadErrorGate from "../../components/load-error/LoadErrorGate";
import { fdate } from "../../utils/helpers";
import {
  can,
  canManageAttendanceRecord,
  scopeAttendance,
  scopeEmployees,
} from "../../utils/permissions";
import { T } from "../../theme/theme";
import { useToast } from "../../components/toast/toastContext";

const ATTENDANCE_STATUSES = [
  { value: "present", label: "Present" },
  { value: "absent", label: "Absent" },
  { value: "late", label: "Late" },
  { value: "leave", label: "On leave" },
];

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const attendanceRecordId = (record) => record?.id ?? record?._docId;

const normalizedAttendanceRecordId = (record) => {
  const recordId = attendanceRecordId(record);
  return recordId == null ? "" : String(recordId);
};

const toLocalDateValue = (date) => {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
};

const attendanceDate = (record) => {
  const value = record?.date;
  if (typeof value === "string") {
    const dateValue = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (dateValue) return dateValue;
  }

  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : toLocalDateValue(date);
};

const normalizeStatus = (status) => {
  const normalizedStatus = String(status || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return normalizedStatus === "on leave" ? "leave" : normalizedStatus;
};

const statusLabel = (status) => {
  const normalizedStatus = normalizeStatus(status);
  const labels = {
    present: "Present",
    absent: "Absent",
    late: "Late",
    leave: "On Leave",
  };
  return labels[normalizedStatus]
    || (normalizedStatus === "unknown"
      ? "Unknown"
      : normalizedStatus.replace(/\b\w/g, (letter) => letter.toUpperCase()));
};

const displayTime = (value) => {
  if (value == null || value === "") return "—";
  if (typeof value === "string" && /^\d{1,2}:\d{2}/.test(value)) return value.slice(0, 5);

  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formTimeValue = (value) => {
  if (typeof value === "string") {
    const match = value.match(/^(\d{1,2}):([0-5]\d)/);
    if (match && Number(match[1]) <= 23) return `${match[1].padStart(2, "0")}:${match[2]}`;
  }

  if (!value) return "";
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const recordTimestamp = (record) => {
  const dateValue = attendanceDate(record);
  const checkIn = typeof record?.checkIn === "string" && /^\d{1,2}:\d{2}/.test(record.checkIn)
    ? new Date(`${dateValue}T${record.checkIn}`).getTime()
    : NaN;
  if (!Number.isNaN(checkIn)) return checkIn;

  for (const value of [record?.updatedAt, record?.createdAt, record?.checkIn, record?.date]) {
    if (!value) continue;
    const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
    if (!Number.isNaN(date.getTime())) return date.getTime();
  }
  return 0;
};

const getInitialAttendanceForm = (date) => ({
  empId: "",
  date,
  status: "present",
  checkIn: "",
  checkOut: "",
  notes: "",
});

const getAttendanceFormFromRecord = (record) => {
  const status = normalizeStatus(record?.status);
  const clearsTimes = status === "absent" || status === "leave";
  return {
    empId: record?.empId == null ? "" : String(record.empId),
    date: attendanceDate(record),
    status,
    checkIn: clearsTimes ? "" : formTimeValue(record?.checkIn),
    checkOut: clearsTimes ? "" : formTimeValue(record?.checkOut),
    notes: record?.notes == null ? "" : String(record.notes),
  };
};

const isValidDateValue = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return toLocalDateValue(date) === value;
};

const AttendancePageContent = ({
  user,
  employees = [],
  attendance = [],
  addAttendance,
  updateAttendance,
  deleteAttendance,
}) => {
  const today = toLocalDateValue(new Date());
  const toast = useToast();
  const [selectedDate, setSelectedDate] = useState(today);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showMarkModal, setShowMarkModal] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [attendanceForm, setAttendanceForm] = useState(() =>
    getInitialAttendanceForm(today),
  );
  const [formErrors, setFormErrors] = useState({});
  const [submitError, setSubmitError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const submissionInProgress = useRef(false);
  const deletionInProgress = useRef(false);

  const scopedAttendance = scopeAttendance(user, attendance, employees);
  const scopedEmployees = scopeEmployees(user, employees);
  const employeeById = new Map(
    scopedEmployees
      .filter((employee) => employee.id != null)
      .map((employee) => [String(employee.id), employee]),
  );
  const selectedDateRecords = scopedAttendance.filter((record) =>
    attendanceDate(record) === selectedDate,
  );
  const statusCounts = selectedDateRecords.reduce((counts, record) => {
    const status = normalizeStatus(record.status);
    if (Object.hasOwn(counts, status)) counts[status] += 1;
    return counts;
  }, { present: 0, absent: 0, late: 0, leave: 0 });
  const markedEmployeeIds = new Set(
    selectedDateRecords
      .filter((record) => record?.empId != null)
      .map((record) => String(record.empId)),
  );
  const activeEmployees = scopedEmployees.filter((employee) =>
    employee.id != null && normalizeStatus(employee.status) === "active",
  );
  const manageableEmployees = activeEmployees.filter((employee) =>
    canManageAttendanceRecord(user, { empId: String(employee.id) }, employees),
  );
  const unmarkedEmployees = activeEmployees.filter((employee) =>
    !markedEmployeeIds.has(String(employee.id)),
  );
  const canMarkAttendance = can(user, "manageAttendance");
  const isEditing = editingRecordId != null;
  const deleteTargetEmployee = deleteTarget
    ? employeeById.get(String(deleteTarget.empId))
    : null;
  const deleteTargetDate = deleteTarget ? attendanceDate(deleteTarget) : "";

  const normalizedSearch = search.trim().toLowerCase();
  const filteredRecords = selectedDateRecords
    .filter((record) =>
      statusFilter === "all" || normalizeStatus(record.status) === statusFilter,
    )
    .filter((record) => {
      if (!normalizedSearch) return true;
      const employee = employeeById.get(String(record.empId));
      return String(employee?.name || "").toLowerCase().includes(normalizedSearch);
    })
    .sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
  const showActionsColumn = filteredRecords.some((record) =>
    canManageAttendanceRecord(user, record, employees),
  );

  const clearFieldError = (field) => {
    setFormErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSubmitError("");
  };

  const updateFormField = (field, value) => {
    setAttendanceForm((current) => ({ ...current, [field]: value }));
    clearFieldError(field);
  };

  const updateFormStatus = (value) => {
    const status = normalizeStatus(value);
    const clearsTimes = status === "absent" || status === "leave";
    setAttendanceForm((current) => ({
      ...current,
      status,
      ...(clearsTimes ? { checkIn: "", checkOut: "" } : {}),
    }));
    setFormErrors((current) => {
      const next = { ...current };
      delete next.status;
      if (clearsTimes) {
        delete next.checkIn;
        delete next.checkOut;
      }
      return next;
    });
    setSubmitError("");
  };

  const openMarkModal = () => {
    setEditingRecordId(null);
    setAttendanceForm(getInitialAttendanceForm(selectedDate || today));
    setFormErrors({});
    setSubmitError("");
    setShowMarkModal(true);
  };

  const openEditModal = (record) => {
    const recordId = normalizedAttendanceRecordId(record);
    if (
      submissionInProgress.current ||
      !recordId ||
      !canManageAttendanceRecord(user, record, employees)
    ) return;

    setEditingRecordId(recordId);
    setAttendanceForm(getAttendanceFormFromRecord(record));
    setFormErrors({});
    setSubmitError("");
    setShowMarkModal(true);
  };

  const closeMarkModal = () => {
    if (submissionInProgress.current) return;
    setShowMarkModal(false);
    setEditingRecordId(null);
    setAttendanceForm(getInitialAttendanceForm(selectedDate || today));
    setFormErrors({});
    setSubmitError("");
  };

  const openDeleteDialog = (record) => {
    if (
      deletionInProgress.current ||
      !canManageAttendanceRecord(user, record, employees)
    ) return;

    setDeleteTarget(record);
    setDeleteError("");
  };

  const closeDeleteDialog = () => {
    if (deletionInProgress.current) return;
    setDeleteTarget(null);
    setDeleteError("");
  };

  const confirmDeleteAttendance = async () => {
    if (deletionInProgress.current || !deleteTarget) return;

    const targetRecordId = normalizedAttendanceRecordId(deleteTarget);
    const latestRecord = targetRecordId
      ? attendance.find((record) =>
        normalizedAttendanceRecordId(record) === targetRecordId,
      )
      : null;

    if (!latestRecord) {
      setDeleteError("This attendance record is no longer available.");
      return;
    }

    if (!canManageAttendanceRecord(user, latestRecord, employees)) {
      setDeleteError("You are no longer authorized to delete this attendance record.");
      return;
    }

    deletionInProgress.current = true;
    setIsDeleting(true);
    setDeleteError("");

    try {
      await deleteAttendance(attendanceRecordId(latestRecord));
      setDeleteTarget(null);
      setDeleteError("");
      toast.success("Attendance record deleted");
    } catch (error) {
      setDeleteError(error?.message || "Unable to delete attendance. Please try again.");
    } finally {
      deletionInProgress.current = false;
      setIsDeleting(false);
    }
  };

  const handleSaveAttendance = async (event) => {
    event.preventDefault();
    if (submissionInProgress.current) return;

    const empId = String(attendanceForm.empId || "");
    const date = String(attendanceForm.date || "").trim();
    const status = normalizeStatus(attendanceForm.status);
    const notes = String(attendanceForm.notes || "").trim();
    const clearsTimes = status === "absent" || status === "leave";
    const checkIn = clearsTimes ? "" : String(attendanceForm.checkIn || "").trim();
    const checkOut = clearsTimes ? "" : String(attendanceForm.checkOut || "").trim();
    const nextErrors = {};

    if (!empId) nextErrors.empId = "Select an employee.";
    if (!date) {
      nextErrors.date = "Select an attendance date.";
    } else if (!isValidDateValue(date)) {
      nextErrors.date = "Enter a valid attendance date.";
    } else if (date > today) {
      nextErrors.date = "Attendance cannot be marked for a future date.";
    }
    if (!ATTENDANCE_STATUSES.some((option) => option.value === status)) {
      nextErrors.status = "Select a valid attendance status.";
    }
    if (checkIn && !TIME_PATTERN.test(checkIn)) {
      nextErrors.checkIn = "Use a valid 24-hour time in HH:mm format.";
    }
    if (checkOut && !TIME_PATTERN.test(checkOut)) {
      nextErrors.checkOut = "Use a valid 24-hour time in HH:mm format.";
    }
    if (
      checkIn &&
      checkOut &&
      TIME_PATTERN.test(checkIn) &&
      TIME_PATTERN.test(checkOut) &&
      checkOut <= checkIn
    ) {
      nextErrors.checkOut = "Check Out must be later than Check In.";
    }

    if (Object.keys(nextErrors).length) {
      setFormErrors(nextErrors);
      setSubmitError("Please correct the highlighted fields.");
      return;
    }

    const latestEmployee = employees.find(
      (employee) => String(employee?.id) === empId,
    );
    const latestScopedEmployeeIds = new Set(
      scopeEmployees(user, employees)
        .filter((employee) => normalizeStatus(employee?.status) === "active")
        .map((employee) => String(employee.id)),
    );
    const candidate = { empId, date, status };
    const latestOriginal = isEditing
      ? attendance.find((record) =>
        normalizedAttendanceRecordId(record) === editingRecordId,
      )
      : null;

    if (isEditing && !latestOriginal) {
      setSubmitError("This attendance record is no longer available.");
      return;
    }

    if (!latestEmployee || !latestScopedEmployeeIds.has(empId)) {
      setFormErrors({ empId: "This employee is no longer available for attendance." });
      setSubmitError("Select an active employee within your attendance scope.");
      return;
    }

    const canManageCandidate = canManageAttendanceRecord(user, candidate, employees);
    const canManageOriginal = !isEditing || canManageAttendanceRecord(
      user,
      latestOriginal,
      employees,
    );
    if (!canMarkAttendance || !canManageOriginal || !canManageCandidate) {
      setSubmitError(isEditing
        ? "You are not authorized to edit this attendance record."
        : "You are not authorized to mark attendance for this employee.");
      return;
    }

    const duplicateExists = attendance.some(
      (record) =>
        String(record?.empId) === empId &&
        attendanceDate(record) === date &&
        (!isEditing || normalizedAttendanceRecordId(record) !== editingRecordId),
    );
    if (duplicateExists) {
      setSubmitError("Attendance is already recorded for this employee on this date.");
      return;
    }

    submissionInProgress.current = true;
    setIsSaving(true);
    setSubmitError("");

    try {
      const timestamp = new Date().toISOString();
      if (isEditing) {
        await updateAttendance(normalizedAttendanceRecordId(latestOriginal), {
          empId,
          date,
          status,
          checkIn,
          checkOut,
          notes,
          updatedAt: timestamp,
        });
      } else {
        await addAttendance({
          empId,
          date,
          status,
          checkIn,
          checkOut,
          notes,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      setSelectedDate(date);
      setShowMarkModal(false);
      toast.success(isEditing ? "Attendance updated" : "Attendance saved");
      setEditingRecordId(null);
      setAttendanceForm(getInitialAttendanceForm(date));
      setFormErrors({});
    } catch (error) {
      setSubmitError(error?.message || (isEditing
        ? "Unable to update attendance. Please try again."
        : "Unable to mark attendance. Please try again."));
    } finally {
      submissionInProgress.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Attendance"
        description={`${scopedAttendance.length} attendance record${scopedAttendance.length === 1 ? "" : "s"} in your scope`}
        actions={canMarkAttendance ? (
          <Btn onClick={openMarkModal}>
            <Plus size={16} aria-hidden="true" />Mark attendance
          </Btn>
        ) : null}
      />

      <FilterBar style={{ alignItems: "flex-end" }}>
        <Input
          className="filter-field"
          label="Attendance date"
          type="date"
          value={selectedDate}
          onChange={(event) => setSelectedDate(event.target.value)}
        />
        <Select
          className="filter-field"
          label="Status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="present">Present</option>
          <option value="absent">Absent</option>
          <option value="late">Late</option>
          <option value="leave">On leave</option>
        </Select>
        <SearchBar
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by employee name"
          ariaLabel="Search attendance by employee name"
        />
      </FilterBar>

      <div className="stat-grid stat-grid--compact">
        <Stat icon={UserCheck} label="Present" value={statusCounts.present} sub="Selected date" color={T.success} />
        <Stat icon={UserX} label="Absent" value={statusCounts.absent} sub="Selected date" color={T.danger} />
        <Stat icon={Clock3} label="Late" value={statusCounts.late} sub="Selected date" color={T.warning} />
        <Stat icon={CalendarDays} label="On leave" value={statusCounts.leave} sub="Selected date" color={T.secondary} />
        <Stat icon={CircleDashed} label="Unmarked" value={unmarkedEmployees.length} sub={`${activeEmployees.length} active in scope`} color={T.mutedLight} />
      </div>

      <div className="section-head">
        <h2>Attendance records</h2>
        <span>{selectedDate}</span>
      </div>

      <DataTable
        label="Attendance records"
        empty={filteredRecords.length === 0 ? (
          <EmptyState
            icon={CalendarCheck2}
            title="No attendance records"
            description={selectedDateRecords.length === 0
              ? "Nothing has been recorded for this date in your scope."
              : "No records match the selected status and search."}
          >
            {selectedDateRecords.length === 0 && canMarkAttendance && (
              <Btn onClick={openMarkModal}><Plus size={16} aria-hidden="true" />Mark attendance</Btn>
            )}
          </EmptyState>
        ) : null}
      >
        <thead>
          <tr>
            <th>Employee</th>
            <th>Department</th>
            <th>Date</th>
            <th>Status</th>
            <th>Check in</th>
            <th>Check out</th>
            <th>Notes</th>
            {showActionsColumn && <th><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {filteredRecords.map((record, index) => {
            const employee = employeeById.get(String(record.empId));
            const date = attendanceDate(record);
            const canEditRecord = canManageAttendanceRecord(user, record, employees);
            const employeeName = employee?.name || "Unknown employee";
            return (
              <tr key={`${record.id ?? record._docId ?? "attendance"}-${index}`}>
                <td data-primary style={{ fontWeight: 500 }}>{employeeName}</td>
                <td data-label="Department" style={{ color: T.mutedLight }}>{employee?.dept || "Unassigned"}</td>
                <td data-label="Date" style={{ whiteSpace: "nowrap", color: T.mutedLight }}>
                  {date ? fdate(`${date}T00:00:00`) : "—"}
                </td>
                <td data-label="Status"><Badge s={statusLabel(record.status)} /></td>
                <td data-label="Check in" className="cell-number">{displayTime(record.checkIn)}</td>
                <td data-label="Check out" className="cell-number">{displayTime(record.checkOut)}</td>
                <td data-label="Notes" className="cell-truncate" style={{ color: T.mutedLight }}>
                  {["string", "number"].includes(typeof record.notes) && String(record.notes).trim()
                    ? String(record.notes)
                    : "—"}
                </td>
                {showActionsColumn && (
                  <td className="cell-actions">
                    {canEditRecord && (
                      <div className="row-actions">
                        <IconButton icon={Pencil} label={`Edit attendance for ${employeeName}`} onClick={() => openEditModal(record)} />
                        <IconButton icon={Trash2} variant="danger" label={`Delete attendance for ${employeeName}`} onClick={() => openDeleteDialog(record)} />
                      </div>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {showMarkModal && (
        <Modal title={isEditing ? "Edit attendance" : "Mark attendance"} onClose={closeMarkModal}>
          <form onSubmit={handleSaveAttendance}>
            <div>
              <Select
                label="Employee"
                value={attendanceForm.empId}
                onChange={(event) => updateFormField("empId", event.target.value)}
                error={formErrors.empId}
                disabled={manageableEmployees.length === 0}
                hint={manageableEmployees.length === 0
                  ? "No active employees are available in your attendance scope."
                  : undefined}
              >
                <option value="">Select an employee</option>
                {manageableEmployees.map((employee) => (
                  <option key={String(employee.id)} value={String(employee.id)}>
                    {employee.name || employee.email || `Employee ${employee.id}`}
                  </option>
                ))}
              </Select>

              <div className="form-grid">
                <Input
                  label="Date"
                  type="date"
                  max={today}
                  value={attendanceForm.date}
                  onChange={(event) => updateFormField("date", event.target.value)}
                  error={formErrors.date}
                />
                <Select
                  label="Status"
                  value={attendanceForm.status}
                  onChange={(event) => updateFormStatus(event.target.value)}
                  error={formErrors.status}
                >
                  {ATTENDANCE_STATUSES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </div>

              <div className="form-grid">
                <Input
                  label="Check in"
                  type="time"
                  value={attendanceForm.checkIn}
                  onChange={(event) => updateFormField("checkIn", event.target.value)}
                  error={formErrors.checkIn}
                  disabled={attendanceForm.status === "absent" || attendanceForm.status === "leave"}
                />
                <Input
                  label="Check out"
                  type="time"
                  value={attendanceForm.checkOut}
                  onChange={(event) => updateFormField("checkOut", event.target.value)}
                  error={formErrors.checkOut}
                  disabled={attendanceForm.status === "absent" || attendanceForm.status === "leave"}
                />
              </div>

              <Textarea
                label="Notes"
                value={attendanceForm.notes}
                onChange={(event) => updateFormField("notes", event.target.value)}
                placeholder="An optional note"
              />

              <FormFeedback>{submitError}</FormFeedback>

              <div className="modal-actions">
                <Btn type="button" variant="ghost" onClick={closeMarkModal} disabled={isSaving}>
                  Cancel
                </Btn>
                <Btn type="submit" disabled={isSaving || manageableEmployees.length === 0}>
                  <Check size={16} aria-hidden="true" />{isSaving
                    ? (isEditing ? "Updating…" : "Saving…")
                    : (isEditing ? "Save changes" : "Save attendance")}
                </Btn>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete attendance record"
          message={(
            <div>
              <div>
                Delete the attendance record for{" "}
                <strong style={{ color: T.text }}>
                  {deleteTargetEmployee?.name || "Unknown employee"}
                </strong>{" "}
                on {deleteTargetDate ? fdate(`${deleteTargetDate}T00:00:00`) : "an unknown date"}?
                This action cannot be undone.
              </div>
              <FormFeedback>{deleteError}</FormFeedback>
            </div>
          )}
          confirmLabel={isDeleting ? "Deleting…" : "Delete record"}
          onConfirm={confirmDeleteAttendance}
          onClose={closeDeleteDialog}
        />
      )}
    </div>
  );
};

// A failed load must not look like "no attendance records found".
const AttendancePage = (props) => (
  <LoadErrorGate errors={props.dataErrors} required={{ attendance: props.attendance, employees: props.employees }}>
    <AttendancePageContent {...props} />
  </LoadErrorGate>
);

export default AttendancePage;
