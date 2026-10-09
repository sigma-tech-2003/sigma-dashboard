import * as mapper from "./mappers/leave.js";
import { createResourceService } from "./resourceService.js";
import { api as defaultApi } from "./apiClient.js";

export function createLeaveService(api = defaultApi) {
  const base = createResourceService({ path: "/leaves", mapper, api });

  return {
    list: base.list,
    get: base.get,

    /** POST /leaves — apply. Only type, dates and reason are sent; the server owns the rest (D40). */
    create: base.create,

    /** PATCH /leaves/:id — approve or reject. Nobody decides their own request (the server refuses). */
    async decide(id, status) {
      return base.read(await api.patch(`/leaves/${id}`, mapper.toApiDecision(status)));
    },

    /**
     * DELETE /leaves/:id — an employee cancelling their OWN pending request. admin and hr use the same call to
     * delete a leave in any status; the server decides which applies. A decided request cannot be cancelled
     * (`leave_already_decided`).
     */
    cancel: (id) => base.remove(id),
  };
}

export const leaveService = createLeaveService();
