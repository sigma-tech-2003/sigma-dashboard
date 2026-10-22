import { useRef, useState } from "react";
import { FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";

import "./Projects.css";
import {
  Badge,
  Btn,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormFeedback,
  FormField,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
} from "../../components";
import { T } from "../../theme/theme";
import { canManageProject, scopeProjects } from "../../utils/permissions";
import { useToast } from "../../components/toast/toastContext";

const PROJECT_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
];
const PROJECT_CREATORS = ["admin", "hr", "manager", "tl"];

const getInitialProjectForm = (user, project = null) => ({
  title: project?.title || project?.name || "",
  description: project?.description || "",
  department: ["manager", "tl"].includes(user.role)
    ? user.dept || ""
    : project?.department || "",
  teamLeadId: user.role === "tl"
    ? String(user.id)
    : project?.teamLeadId == null ? "" : String(project.teamLeadId),
  assignedEmployeeIds: Array.isArray(project?.assignedEmployeeIds)
    ? Array.from(new Set(project.assignedEmployeeIds.map((id) => String(id))))
    : [],
  startDate: project?.startDate || "",
  dueDate: project?.dueDate || "",
  status: PROJECT_STATUSES.some(({ value }) => value === project?.status)
    ? project.status
    : "active",
});

const validateProject = (project) => {
  const errors = {};
  const startDate = Date.parse(project.startDate);
  const dueDate = Date.parse(project.dueDate);
  if (!project.title) errors.title = "Project title is required.";
  if (!project.department) errors.department = "Department is required.";
  if (project.assignedEmployeeIds.length === 0) {
    errors.assignedEmployeeIds = "Select at least one employee.";
  }
  if (!project.startDate) errors.startDate = "Start date is required.";
  else if (Number.isNaN(startDate)) errors.startDate = "Enter a valid start date.";
  if (!project.dueDate) errors.dueDate = "Due date is required.";
  else if (Number.isNaN(dueDate)) errors.dueDate = "Enter a valid due date.";
  if (
    !Number.isNaN(startDate)
    && !Number.isNaN(dueDate)
    && dueDate < startDate
  ) {
    errors.dueDate = "Due date must be on or after the start date.";
  }
  return errors;
};

const ProjectModal = ({
  user,
  employees,
  departments,
  addProject,
  updateProject,
  project,
  onClose,
}) => {
  const toast = useToast();
  const isEditing = Boolean(project);
  const [form, setForm] = useState(() => getInitialProjectForm(user, project));
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState("");
  const [saving, setSaving] = useState(false);

  const fixedDepartment = ["manager", "tl"].includes(user.role);
  const selectedDepartment = fixedDepartment ? user.dept || "" : form.department;
  const departmentOptions = Array.from(new Set([
    ...(departments || []).map((department) => department.name),
    ...employees.map((employee) => employee.dept),
    project?.department,
    user.dept,
  ].filter(Boolean))).sort();

  const departmentTeamLeads = employees.filter((employee) =>
    employee.id != null
    && employee.role === "tl"
    && employee.dept === selectedDepartment,
  );
  const teamLeadOptions = user.role === "tl"
    ? [employees.find((employee) => String(employee.id) === String(user.id)) || user]
    : departmentTeamLeads;
  const employeeOptions = employees.filter((employee) => {
    if (employee.id == null || employee.role !== "employee") return false;
    if (user.role === "tl") {
      return employee.dept === selectedDepartment
        && employee.teamLeadId != null
        && String(employee.teamLeadId) === String(user.id);
    }
    return employee.dept === selectedDepartment;
  });

  const clearFieldError = (field) => {
    setErrors((currentErrors) => ({ ...currentErrors, [field]: "" }));
    setSubmitError("");
  };

  const updateField = (field, value) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    clearFieldError(field);
  };

  const changeDepartment = (department) => {
    setForm((currentForm) => ({
      ...currentForm,
      department,
      teamLeadId: "",
      assignedEmployeeIds: [],
    }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      department: "",
      assignedEmployeeIds: "",
    }));
    setSubmitError("");
  };

  const closeModal = () => {
    if (saving) return;
    setForm(getInitialProjectForm(user, project));
    setErrors({});
    setSubmitError("");
    onClose();
  };

  const saveProject = async (event) => {
    event.preventDefault();
    if (saving) return;

    const allowedTeamLeadIds = new Set(teamLeadOptions.map((employee) => String(employee.id)));
    const allowedEmployeeIds = new Set(employeeOptions.map((employee) => String(employee.id)));
    const normalizedAssignedEmployeeIds = Array.from(new Set(
      form.assignedEmployeeIds
        .map((id) => String(id))
        .filter((id) => allowedEmployeeIds.has(id)),
    ));
    const requestedTeamLeadId = user.role === "tl" ? String(user.id) : String(form.teamLeadId || "");
    const timestamp = new Date().toISOString();
    const projectId = project?.id ?? project?._docId;
    const candidate = {
      ...(isEditing ? { id: projectId } : {}),
      title: form.title.trim(),
      description: form.description.trim(),
      department: selectedDepartment,
      teamLeadId: allowedTeamLeadIds.has(requestedTeamLeadId) ? requestedTeamLeadId : null,
      assignedEmployeeIds: normalizedAssignedEmployeeIds,
      startDate: form.startDate,
      dueDate: form.dueDate,
      status: PROJECT_STATUSES.some(({ value }) => value === form.status) ? form.status : "active",
      createdAt: isEditing ? project.createdAt ?? timestamp : timestamp,
      updatedAt: timestamp,
    };
    const validationErrors = validateProject(candidate);

    if (isEditing && projectId == null) {
      setSubmitError("This project cannot be updated because its ID is missing.");
      return;
    }

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setSubmitError("Please correct the highlighted fields.");
      return;
    }

    if (!canManageProject(user, candidate, employees)) {
      setSubmitError(`You do not have permission to ${isEditing ? "edit" : "create"} this project in the selected scope.`);
      return;
    }

    setSaving(true);
    setSubmitError("");
    try {
      if (isEditing) {
        await updateProject(projectId, candidate);
      } else {
        await addProject(candidate);
      }
      setForm(getInitialProjectForm(user));
      setErrors({});
      onClose();
      toast.success(isEditing ? "Project saved" : "Project created");
    } catch (error) {
      setSubmitError(error?.message || `Unable to ${isEditing ? "update" : "create"} the project. Please try again.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={isEditing ? "Edit project" : "Create project"} onClose={closeModal} wide>
      <form onSubmit={saveProject}>
        <div className="form-grid">
          <Input
            label="Project title"
            value={form.title}
            error={errors.title}
            onChange={(event) => updateField("title", event.target.value)}
          />
          <Select
            label="Department"
            value={selectedDepartment}
            error={errors.department}
            disabled={fixedDepartment}
            onChange={(event) => changeDepartment(event.target.value)}
          >
            <option value="">Select a department</option>
            {departmentOptions.map((department) => (
              <option key={department} value={department}>{department}</option>
            ))}
          </Select>
          <Select
            label="Team lead"
            value={user.role === "tl" ? String(user.id) : form.teamLeadId}
            disabled={user.role === "tl" || !selectedDepartment}
            onChange={(event) => updateField("teamLeadId", event.target.value)}
          >
            {user.role !== "tl" && <option value="">Unassigned</option>}
            {teamLeadOptions.map((employee) => (
              <option key={String(employee.id)} value={String(employee.id)}>
                {employee.name || employee.email || "Unnamed team lead"}
              </option>
            ))}
          </Select>
          <Select
            label="Status"
            value={form.status}
            onChange={(event) => updateField("status", event.target.value)}
          >
            {PROJECT_STATUSES.map((status) => (
              <option key={status.value} value={status.value}>{status.label}</option>
            ))}
          </Select>
          <Input
            label="Start date"
            type="date"
            value={form.startDate}
            error={errors.startDate}
            onChange={(event) => updateField("startDate", event.target.value)}
          />
          <Input
            label="Due date"
            type="date"
            value={form.dueDate}
            error={errors.dueDate}
            onChange={(event) => updateField("dueDate", event.target.value)}
          />
        </div>

        <Textarea
          label="Description"
          rows={3}
          value={form.description}
          onChange={(event) => updateField("description", event.target.value)}
        />

        <FormField
          id="project-assigned-employees"
          label="Assigned employees"
          error={errors.assignedEmployeeIds}
          hint={selectedDepartment ? "Select one or more employees." : "Select a department first."}
        >
          <select
            id="project-assigned-employees"
            className="select-field projects-multiselect"
            multiple
            size={Math.min(Math.max(employeeOptions.length, 3), 6)}
            value={form.assignedEmployeeIds}
            disabled={!selectedDepartment || employeeOptions.length === 0}
            aria-invalid={Boolean(errors.assignedEmployeeIds)}
            aria-describedby={errors.assignedEmployeeIds ? "project-assigned-employees-error" : "project-assigned-employees-hint"}
            onChange={(event) => updateField(
              "assignedEmployeeIds",
              Array.from(event.target.selectedOptions, (option) => String(option.value)),
            )}
          >
            {employeeOptions.map((employee) => (
              <option key={String(employee.id)} value={String(employee.id)}>
                {employee.name || employee.email || `Employee ${employee.id}`}
              </option>
            ))}
          </select>
        </FormField>

        <FormFeedback>{submitError}</FormFeedback>
        <div className="modal-actions">
          <Btn variant="ghost" onClick={closeModal} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving}>
            {saving
              ? isEditing ? "Saving…" : "Creating…"
              : isEditing ? "Save changes" : "Create project"}
          </Btn>
        </div>
      </form>
    </Modal>
  );
};

const ProjectsPage = ({
  user,
  projects = [],
  employees = [],
  departments = [],
  addProject,
  updateProject,
  deleteProject,
}) => {
  const toast = useToast();
  const [projectModal, setProjectModal] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const deletionInProgress = useRef(false);
  const scopedProjects = scopeProjects(user, projects, employees);
  const canCreateProject = PROJECT_CREATORS.includes(user.role);
  const showActionsColumn = user.role !== "employee" && scopedProjects.some((project) =>
    canManageProject(user, project, employees),
  );
  const employeeById = new Map(
    employees.map((employee) => [String(employee.id), employee]),
  );
  const createButton = <Btn onClick={() => setProjectModal({ project: null })}><Plus size={16} aria-hidden="true" />Create project</Btn>;

  const openDeleteDialog = (project) => {
    if (deletionInProgress.current) return;
    setDeleteTarget(project);
    setDeleteError("");
  };

  const closeDeleteDialog = () => {
    if (deletionInProgress.current) return;
    setDeleteTarget(null);
    setDeleteError("");
  };

  const confirmDeleteProject = async () => {
    if (deletionInProgress.current || !deleteTarget) return;

    const selectedProjectId = deleteTarget.id;
    const latestProject = selectedProjectId == null
      ? null
      : projects.find((project) =>
        project.id != null && String(project.id) === String(selectedProjectId),
      );

    if (!latestProject) {
      setDeleteError("This project is no longer available or does not have a valid ID.");
      return;
    }

    if (user.role === "employee" || !canManageProject(user, latestProject, employees)) {
      setDeleteError("You no longer have permission to delete this project.");
      return;
    }

    deletionInProgress.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteProject(latestProject.id);
      setDeleteTarget(null);
      setDeleteError("");
      toast.success("Project deleted");
    } catch (error) {
      setDeleteError(error?.message || "Unable to delete the project. Please try again.");
    } finally {
      deletionInProgress.current = false;
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Projects"
        description={`${scopedProjects.length} project${scopedProjects.length === 1 ? "" : "s"} in your scope`}
        actions={canCreateProject ? createButton : null}
      />

      <DataTable
        label="Projects"
        empty={scopedProjects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description={canCreateProject
              ? "Create a project, assign people to it, and its KPIs and progress will be tracked from here."
              : "Projects you are assigned to will be listed here."}
          >
            {canCreateProject && createButton}
          </EmptyState>
        ) : null}
      >
        <thead>
          <tr>
            <th>Project</th>
            <th>Department</th>
            <th>Status</th>
            <th>Team lead</th>
            <th className="cell-number">People</th>
            {showActionsColumn && <th><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {scopedProjects.map((project, index) => {
            const assignedEmployeeIds = Array.isArray(project.assignedEmployeeIds)
              ? project.assignedEmployeeIds
              : [];
            const assignedEmployeeNames = assignedEmployeeIds
              .map((id) => employeeById.get(String(id))?.name)
              .filter(Boolean);
            const teamLead = project.teamLeadId == null
              ? null
              : employeeById.get(String(project.teamLeadId));
            const canEditProject = canManageProject(user, project, employees);
            const canDeleteProject = user.role !== "employee" && canEditProject;
            const projectName = project.title || project.name || "Untitled project";

            return (
              <tr key={`${project.id ?? project._docId ?? "project"}-${index}`}>
                <td data-primary style={{ fontWeight: 500 }}>{projectName}</td>
                <td data-label="Department" style={{ color: T.mutedLight }}>{project.department || "Unassigned"}</td>
                <td data-label="Status"><Badge s={project.status || "Unknown"} /></td>
                <td data-label="Team lead" style={{ color: T.mutedLight }}>{teamLead?.name || "Unassigned"}</td>
                <td
                  data-label="People"
                  className="cell-number"
                  title={assignedEmployeeNames.length ? assignedEmployeeNames.join(", ") : undefined}
                >
                  {assignedEmployeeIds.length}
                </td>
                {showActionsColumn && (
                  <td className="cell-actions">
                    <div className="row-actions">
                      {canEditProject && (
                        <IconButton icon={Pencil} label={`Edit ${projectName}`} onClick={() => setProjectModal({ project })} />
                      )}
                      {canDeleteProject && (
                        <IconButton icon={Trash2} variant="danger" label={`Delete ${projectName}`} onClick={() => openDeleteDialog(project)} />
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {projectModal && (
        <ProjectModal
          user={user}
          employees={employees}
          departments={departments}
          addProject={addProject}
          updateProject={updateProject}
          project={projectModal.project}
          onClose={() => setProjectModal(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete project"
          message={(
            <div>
              <div>
                Delete “{deleteTarget.title || deleteTarget.name || "Untitled project"}”? This action cannot be undone.
              </div>
              <FormFeedback>{deleteError}</FormFeedback>
            </div>
          )}
          confirmLabel={deleting ? "Deleting…" : "Delete project"}
          onConfirm={confirmDeleteProject}
          onClose={closeDeleteDialog}
        />
      )}
    </div>
  );
};

export default ProjectsPage;
