import { createContext, useContext } from "react";

// Outside a provider (a test, a page rendered on its own) toasts quietly do nothing rather than throwing.
const NOOP = { success: () => {}, info: () => {}, dismiss: () => {} };

export const ToastContext = createContext(NOOP);

export const useToast = () => useContext(ToastContext);
