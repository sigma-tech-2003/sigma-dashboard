// Managers and tls used to read projects and KPIs through a callable (`getScopedWorkspace`) because Firestore's
// rules could not express their scope. The API scopes every read server-side (migration-plan Phase 10 item 7), so
// they read projects and KPIs directly like everyone else and there is nothing left to load here.
//
// Kept as an inert hook only so App.jsx, which still calls it, needs no change; both go in Phase 11.
const NOTHING = Object.freeze({
  projects: undefined,
  kpis: undefined,
  loading: false,
  error: null,
  refresh: () => Promise.resolve(),
});

export function useScopedWorkspace() {
  return NOTHING;
}
