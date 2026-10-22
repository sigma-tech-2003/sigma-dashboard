// The list of toasts on screen, as pure functions so the rules can be tested: at most three at once (the oldest goes), and
// the same message twice in a row replaces the first instead of stacking. A toast is `leaving` while it plays its exit
// and is removed once that has finished.
export const MAX_TOASTS = 3;
export const TOAST_DURATION_MS = 4500;

export const toastReducer = (state, action) => {
  switch (action.type) {
    case "add": {
      const next = state.filter((toast) => toast.message !== action.toast.message);
      return [...next, action.toast].slice(-MAX_TOASTS);
    }
    case "leave":
      return state.map((toast) => (toast.id === action.id ? { ...toast, leaving: true } : toast));
    case "remove":
      return state.filter((toast) => toast.id !== action.id);
    default:
      return state;
  }
};
