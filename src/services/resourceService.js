import { api as defaultApi } from "./apiClient.js";
import { withDocId } from "./legacyShape.js";

// The common shape of a domain service: list / get / create / update / remove over the API, with the
// per-resource mapper (D39) translating both ways. Pages never see snake_case and the API never sees a page's
// field names.
//
//   - A client-generated `id` is never sent: the mappers only emit the schema's keys, and `create` returns the
//     record the SERVER made, so its id is the real one. (The pages' `id: Date.now()` is simply ignored.)
//   - `update(id, changes, { original })` sends only what changed against `original` (see mappers/common.js).
//     When nothing changed there is nothing to send, and the request is skipped.
//   - Every record comes back page-shaped with `_docId` (see legacyShape.js).

export function createResourceService({ path, mapper, api = defaultApi, onLoaded, writeContext = () => ({}) }) {
  const read = (row) => withDocId(mapper.fromApi(row));
  const contextFor = (context = {}) => ({ ...writeContext(), ...context });

  return {
    path,
    api,
    read,

    async list() {
      const rows = await api.get(path);
      const records = rows.map(read);
      onLoaded?.(records);
      return records;
    },

    async get(id) {
      return read(await api.get(`${path}/${id}`));
    },

    async create(record, context) {
      const created = read(await api.post(path, mapper.toApiCreate(record, contextFor(context))));
      onLoaded?.([created]);
      return created;
    },

    async update(id, changes, context) {
      const body = mapper.toApiUpdate(changes, contextFor(context));
      if (Object.keys(body).length === 0) return context?.original ?? null;
      return read(await api.patch(`${path}/${id}`, body));
    },

    async remove(id, body) {
      await api.delete(`${path}/${id}`, body);
    },
  };
}
