import { legacyCodeFor } from "./mutationErrors.js";
import { projectService } from "./projectService.js";

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "permission-denied": "You do not have permission to manage this project.",
  "invalid-argument": "Review the project details and try again.",
  "not-found": "This project or a referenced employee could not be found.",
  "already-exists": "This project conflicts with an existing record.",
  "failed-precondition": "The project could not be verified in its current state.",
  aborted: "The project changed during this operation. Please try again.",
  unavailable: "Project management is temporarily unavailable. Please try again.",
  "malformed-response": "The project response could not be verified.",
  internal: "Project management could not be completed.",
});

export class ProjectMutationError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "ProjectMutationError";
    this.code = safeCode;
  }
}

const failure = (error) => (error instanceof ProjectMutationError ? error : new ProjectMutationError(legacyCodeFor(error)));

const requiredId = (value) => {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new ProjectMutationError("invalid-argument");
  return id;
};

/** POST /projects. Resolves the created project, whose `id` is the server's. */
export async function createProject(project) {
  try {
    return await projectService.create(project);
  } catch (error) {
    throw failure(error);
  }
}

/** PATCH /projects/:id, sending only what changed against `original` when it is given. */
export async function updateProject(projectId, updates, { original } = {}) {
  try {
    return await projectService.update(requiredId(projectId), updates, { original });
  } catch (error) {
    throw failure(error);
  }
}

export async function deleteProject(projectId) {
  try {
    const id = requiredId(projectId);
    await projectService.remove(id);
    return { id, deleted: true };
  } catch (error) {
    throw failure(error);
  }
}
