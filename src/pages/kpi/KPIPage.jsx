// src/pages/kpi/KPIPage.jsx
import { useRef, useState } from "react";
import { Plus, Check, Target } from "lucide-react";

import { T } from "../../theme/theme";
import {
  getProjectKpiRatingLabel,
  isValidProjectKpiScore,
  kpiScore,
  pct,
  perfColor,
  perfLabel,
  PROJECT_KPI_SCORE_MAX,
  PROJECT_KPI_SCORE_MIN,
} from "../../utils/helpers";
import {
  can,
  canManageProject,
  canRateProjectKpi,
  scopeProjectKpis,
  scopeProjects,
} from "../../utils/permissions";
import Avatar      from "../../components/avatar/Avatar";
import EmptyState  from "../../components/empty-state/EmptyState";
import FormFeedback from "../../components/form-feedback/FormFeedback";
import Modal       from "../../components/modal/Modal";
import Input       from "../../components/input/Input";
import Select      from "../../components/select/Select";
import Btn         from "../../components/btn/Btn";
import ProgressBar from "../../components/ProgressBar/ProgressBar";

const INITIAL_KPI_FORM = {
  projectId: "",
  empId: "",
  title: "",
  target: "",
  current: "0",
  weight: "",
  period: "Q1 2025",
};

const PROJECT_KPI_RATING_OPTIONS = Array.from(
  { length: PROJECT_KPI_SCORE_MAX - PROJECT_KPI_SCORE_MIN + 1 },
  (_, index) => PROJECT_KPI_SCORE_MIN + index,
);

const getKpiId = (kpi) => kpi.id ?? kpi._docId;

const KPIPage = ({
  kpis = [],
  addKpi,
  updateKpi,
  employees = [],
  projects = [],
  user,
}) => {
  const [modal,  setModal]  = useState(false);
  const [form,   setForm]   = useState(INITIAL_KPI_FORM);
  const [selEmp, setSelEmp] = useState("all");
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState("");
  const [saving, setSaving] = useState(false);
  const [ratingValues, setRatingValues] = useState({});
  const [ratingErrors, setRatingErrors] = useState({});
  const [savingRatings, setSavingRatings] = useState({});
  const submissionInProgress = useRef(false);
  const ratingSavesInProgress = useRef(new Set());

  const canManageKpis = can(user, "manageKpis");
  const scopedKpis = scopeProjectKpis(user, kpis, projects, employees);
  const visibleProjects = scopeProjects(user, projects, employees);
  const visibleEmployeeIds = new Set(scopedKpis.map((kpi) => String(kpi.empId)));
  const scopedEmployees = employees.filter((employee) =>
    employee.role === "employee" && visibleEmployeeIds.has(String(employee.id)),
  );
  const visible = selEmp === "all"
    ? scopedKpis
    : scopedKpis.filter((kpi) => String(kpi.empId) === String(selEmp));

  const selectedVisibleProject = visibleProjects.find((project) =>
    project.id != null && String(project.id) === String(form.projectId),
  );
  const selectedProjectEmployeeIds = new Set(
    (Array.isArray(selectedVisibleProject?.assignedEmployeeIds)
      ? selectedVisibleProject.assignedEmployeeIds
      : []).map((id) => String(id)),
  );
  const projectEmployees = employees.filter((employee) =>
    employee.id != null
    && employee.role === "employee"
    && selectedProjectEmployeeIds.has(String(employee.id)),
  );

  const empKpiSummary = scopedEmployees.filter(e => e.role === "employee").map(e => {
    const eks = scopedKpis.filter(k => String(k.empId) === String(e.id));
    return { emp: e, kpis: eks, score: kpiScore(eks), label: perfLabel(kpiScore(eks)) };
  }).filter(s => s.kpis.length > 0);

  const updateForm = (field, value) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    setErrors((currentErrors) => ({ ...currentErrors, [field]: "" }));
    setSubmitError("");
  };

  const changeProject = (projectId) => {
    setForm((currentForm) => ({ ...currentForm, projectId, empId: "" }));
    setErrors((currentErrors) => ({ ...currentErrors, projectId: "", empId: "" }));
    setSubmitError("");
  };

  const openModal = () => {
    setForm(INITIAL_KPI_FORM);
    setErrors({});
    setSubmitError("");
    setModal(true);
  };

  const closeModal = () => {
    if (submissionInProgress.current) return;
    setModal(false);
    setForm(INITIAL_KPI_FORM);
    setErrors({});
    setSubmitError("");
  };

  const save = async (event) => {
    event.preventDefault();
    if (submissionInProgress.current) return;

    const title = form.title.trim();
    const period = form.period.trim();
    const target = Number(form.target);
    const current = Number(form.current);
    const weight = Number(form.weight);
    const validationErrors = {};

    if (!title) validationErrors.title = "KPI title is required.";
    if (!form.projectId) validationErrors.projectId = "Select a project.";
    if (!form.empId) validationErrors.empId = "Select an employee.";
    if (!period) validationErrors.period = "Period is required.";
    if (!Number.isFinite(target) || target <= 0) {
      validationErrors.target = "Target must be greater than zero.";
    }
    if (form.current === "" || !Number.isFinite(current) || current < 0) {
      validationErrors.current = "Current must be zero or greater.";
    }
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) {
      validationErrors.weight = "Weight must be from 1 through 100.";
    }

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setSubmitError("Please correct the highlighted fields.");
      return;
    }

    const selectedProject = projects.find((project) =>
      project.id != null && String(project.id) === String(form.projectId),
    );
    const selectedEmployee = employees.find((employee) =>
      employee.id != null && String(employee.id) === String(form.empId),
    );
    const employeeIsAssigned = Boolean(selectedProject)
      && Array.isArray(selectedProject.assignedEmployeeIds)
      && selectedProject.assignedEmployeeIds.some((id) => String(id) === String(form.empId));

    if (!selectedProject) {
      setSubmitError("The selected project is no longer available.");
      return;
    }
    if (!selectedEmployee || !employeeIsAssigned) {
      setSubmitError("The selected employee is no longer assigned to this project.");
      return;
    }
    if (!canManageKpis || !canManageProject(user, selectedProject, employees)) {
      setSubmitError("You no longer have permission to assign a KPI for this project.");
      return;
    }

    submissionInProgress.current = true;
    setSaving(true);
    setSubmitError("");
    try {
      await addKpi({
        id: Date.now(),
        projectId: String(selectedProject.id),
        empId: String(selectedEmployee.id),
        title,
        target,
        current,
        weight,
        period,
        status: "active",
        rating: null,
        ratedBy: null,
        ratedAt: null,
      });
      setModal(false);
      setForm(INITIAL_KPI_FORM);
      setErrors({});
    } catch (error) {
      setSubmitError(error?.message || "Unable to assign the KPI. Please try again.");
    } finally {
      submissionInProgress.current = false;
      setSaving(false);
    }
  };

  const updateCurrent = async (id, val) => {
    if (!canManageKpis) return;
    await updateKpi(id, { current: Math.max(0, +val) });
  };

  const changeRating = (kpiKey, value) => {
    setRatingValues((currentValues) => ({ ...currentValues, [kpiKey]: value }));
    setRatingErrors((currentErrors) => ({ ...currentErrors, [kpiKey]: "" }));
  };

  const saveRating = async (kpi, kpiKey, selectedRating) => {
    if (ratingSavesInProgress.current.has(kpiKey)) return;

    if (!isValidProjectKpiScore(selectedRating)) {
      setRatingErrors((currentErrors) => ({
        ...currentErrors,
        [kpiKey]: "Select a valid rating from 1 through 10.",
      }));
      return;
    }

    const selectedKpiId = getKpiId(kpi);
    const latestKpi = selectedKpiId == null
      ? null
      : kpis.find((candidate) =>
        getKpiId(candidate) != null
        && String(getKpiId(candidate)) === String(selectedKpiId),
      );
    const latestProject = latestKpi?.projectId == null
      ? null
      : projects.find((project) =>
        project.id != null && String(project.id) === String(latestKpi.projectId),
      );

    if (!latestKpi) {
      setRatingErrors((currentErrors) => ({
        ...currentErrors,
        [kpiKey]: "This KPI is no longer available.",
      }));
      return;
    }
    if (!latestProject) {
      setRatingErrors((currentErrors) => ({
        ...currentErrors,
        [kpiKey]: "The related project is no longer available.",
      }));
      return;
    }
    if (user.id == null || !canRateProjectKpi(user, latestKpi, projects, employees)) {
      setRatingErrors((currentErrors) => ({
        ...currentErrors,
        [kpiKey]: "You no longer have permission to rate this KPI.",
      }));
      return;
    }

    ratingSavesInProgress.current.add(kpiKey);
    setSavingRatings((currentRatings) => ({ ...currentRatings, [kpiKey]: true }));
    setRatingErrors((currentErrors) => ({ ...currentErrors, [kpiKey]: "" }));
    try {
      await updateKpi(getKpiId(latestKpi), {
        rating: Number(selectedRating),
        ratedBy: String(user.id),
        ratedAt: new Date().toISOString(),
      });
    } catch (error) {
      setRatingErrors((currentErrors) => ({
        ...currentErrors,
        [kpiKey]: error?.message || "Unable to save the rating. Please try again.",
      }));
    } finally {
      ratingSavesInProgress.current.delete(kpiKey);
      setSavingRatings((currentRatings) => ({ ...currentRatings, [kpiKey]: false }));
    }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>KPI Tracker</div>
          <div style={{ fontSize: 12, color: T.muted }}>Performance indicators & scoring — Q1 2025</div>
        </div>
        {canManageKpis && (
          <Btn onClick={openModal}>
            <Plus size={14} />Assign KPI
          </Btn>
        )}
      </div>

      {/* KPI summary cards */}
      {canManageKpis && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          {empKpiSummary.map(s => (
            <div key={s.emp.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, minWidth: 180, flex: "1 1 180px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <Avatar emp={s.emp} size={32} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{s.emp.name.split(" ")[0]}</div>
                  <div style={{ fontSize: 10, color: T.muted }}>{s.emp.dept}</div>
                </div>
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, color: perfColor(s.score) }}>{s.score}%</div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>{s.label}</div>
              <ProgressBar value={s.score} color={perfColor(s.score)} h={4} />
            </div>
          ))}
        </div>
      )}

      {/* Employee filter */}
      {canManageKpis && scopedEmployees.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <select
            value={selEmp}
            onChange={e => setSelEmp(e.target.value)}
            style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px", color: T.text, fontSize: 13, outline: "none" }}>
            <option value="all">All Employees</option>
            {scopedEmployees.filter(e => e.role === "employee").map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* KPI cards grid */}
      {visible.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No KPI records available"
          description={selEmp === "all"
            ? "There are no KPI records in your current scope."
            : "There are no KPI records for the selected employee."}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14 }}>
        {visible.map((k, index) => {
          const p   = pct(k.current, k.target);
          const emp = employees.find(e => String(e.id) === String(k.empId));
          const kpiKey = String(getKpiId(k) ?? `kpi-${index}`);
          const hasProjectId = k.projectId != null && String(k.projectId).trim() !== "";
          const project = hasProjectId
            ? projects.find(candidate =>
              candidate.id != null && String(candidate.id) === String(k.projectId),
            )
            : null;
          const projectTitle = hasProjectId
            ? project?.title || project?.name || "Project unavailable"
            : "Legacy KPI";
          const hasValidRating = isValidProjectKpiScore(k.rating);
          const ratingLabel = getProjectKpiRatingLabel(k.rating);
          const ratingResult = hasValidRating
            ? `${Number(k.rating)}/10 · ${ratingLabel}`
            : ratingLabel;
          const selectedRating = ratingValues[kpiKey]
            ?? (hasValidRating ? String(Number(k.rating)) : String(PROJECT_KPI_SCORE_MIN));
          const canEditRating = canRateProjectKpi(user, k, projects, employees);
          const ratingIsSaving = Boolean(savingRatings[kpiKey]);
          return (
            <div key={kpiKey}
              style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, transition: "all .2s" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = perfColor(p))}
              onMouseLeave={e => (e.currentTarget.style.borderColor = T.border)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>{k.title}</div>
                  <div style={{ fontSize: 11, color: T.primary, fontWeight: 700 }}>{projectTitle}</div>
                  {canManageKpis && emp && <div style={{ fontSize: 11, color: T.muted }}>{emp.name} · {emp.dept}</div>}
                  <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Period: {k.period} · Weight: {k.weight}%</div>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: perfColor(p) }}>{p}%</div>
              </div>
              <ProgressBar value={k.current} max={k.target} color={perfColor(p)} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: T.muted }}>{k.current?.toLocaleString()} / {k.target?.toLocaleString()}</span>
                <span style={{ fontSize: 11, color: perfColor(p), fontWeight: 700 }}>{perfLabel(p)}</span>
              </div>
              <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 12, paddingTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 11, color: T.muted }}>Project rating</span>
                  <span style={{ fontSize: 12, color: hasValidRating ? T.text : T.muted, fontWeight: 700 }}>
                    {ratingResult}
                  </span>
                </div>
                {canEditRating && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    <select
                      aria-label={`Rating for ${k.title || "KPI"}`}
                      value={selectedRating}
                      disabled={ratingIsSaving}
                      onChange={event => changeRating(kpiKey, event.target.value)}
                      style={{
                        background: T.surface,
                        border: `1px solid ${ratingErrors[kpiKey] ? T.danger : T.border}`,
                        borderRadius: 6,
                        color: T.text,
                        fontSize: 12,
                        outline: "none",
                        padding: "5px 8px",
                      }}
                    >
                      {PROJECT_KPI_RATING_OPTIONS.map(score => (
                        <option key={score} value={String(score)}>{score}</option>
                      ))}
                    </select>
                    <Btn
                      sm
                      onClick={() => saveRating(k, kpiKey, selectedRating)}
                      disabled={ratingIsSaving}
                    >
                      {ratingIsSaving ? "Saving…" : "Save Rating"}
                    </Btn>
                  </div>
                )}
                {ratingErrors[kpiKey] && (
                  <div role="alert" style={{ color: T.danger, fontSize: 11, marginTop: 8 }}>
                    {ratingErrors[kpiKey]}
                  </div>
                )}
              </div>
              {canManageKpis && (
                <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: T.muted, flexShrink: 0 }}>Update:</span>
                  <input
                    type="number"
                    defaultValue={k.current}
                    onBlur={e => updateCurrent(k.id, e.target.value)}
                    style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 8px", color: T.text, fontSize: 12, outline: "none" }}
                  />
                </div>
              )}
            </div>
          );
        })}
        </div>
      )}

      {/* Assign KPI Modal */}
      {modal && (
        <Modal title="Assign New KPI" onClose={closeModal}>
          <form onSubmit={save}>
            <Select
              label="Project"
              value={form.projectId}
              error={errors.projectId}
              disabled={visibleProjects.length === 0}
              hint={visibleProjects.length === 0 ? "No manageable projects are available." : undefined}
              onChange={e => changeProject(e.target.value)}
            >
              <option value="">Select project</option>
              {visibleProjects.filter(project => project.id != null).map(project => (
                <option key={String(project.id)} value={String(project.id)}>
                  {project.title || project.name || "Untitled project"}
                </option>
              ))}
            </Select>
            <Select
              label="Employee"
              value={form.empId}
              error={errors.empId}
              disabled={!selectedVisibleProject || projectEmployees.length === 0}
              hint={selectedVisibleProject && projectEmployees.length === 0
                ? "This project has no assigned employees available."
                : "Select a project first, then choose an assigned employee."}
              onChange={e => updateForm("empId", e.target.value)}
            >
              <option value="">Select employee</option>
              {projectEmployees.map(employee => (
                <option key={String(employee.id)} value={String(employee.id)}>
                  {employee.name} — {employee.dept}
                </option>
              ))}
            </Select>
            <Input
              label="KPI Title"
              value={form.title}
              error={errors.title}
              onChange={e => updateForm("title", e.target.value)}
            />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "0 12px" }}>
              <Input
                label="Target"
                value={form.target}
                error={errors.target}
                onChange={e => updateForm("target", e.target.value)}
                type="number"
              />
              <Input
                label="Current"
                value={form.current}
                error={errors.current}
                onChange={e => updateForm("current", e.target.value)}
                type="number"
              />
              <Input
                label="Weight %"
                value={form.weight}
                error={errors.weight}
                onChange={e => updateForm("weight", e.target.value)}
                type="number"
              />
            </div>
            <Input
              label="Period"
              value={form.period}
              error={errors.period}
              onChange={e => updateForm("period", e.target.value)}
            />
            <FormFeedback>{submitError}</FormFeedback>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Btn variant="ghost" onClick={closeModal} disabled={saving}>Cancel</Btn>
              <Btn type="submit" disabled={saving || visibleProjects.length === 0}>
                <Check size={13} />{saving ? "Assigning…" : "Assign KPI"}
              </Btn>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default KPIPage;
