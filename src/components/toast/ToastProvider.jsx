import "./Toast.css";
import { useCallback, useMemo, useReducer, useRef } from "react";
import { Info, X } from "lucide-react";
import { DISTANCE, DURATION, EASE } from "../../theme/motion";
import { gsap, useGsap } from "../../hooks/motion/useGsap";
import { ToastContext } from "./toastContext";
import { TOAST_DURATION_MS, toastReducer } from "./toastQueue";

const ToastItem = ({ toast, onDismiss, onGone }) => {
  const ref = useRef(null);
  const timer = useRef(null);

  // Enter: rise and fade in, and the tick draws itself. The auto-dismiss timer starts here and stops with the toast.
  useGsap(ref, ({ reduced }) => {
    const element = ref.current;
    if (!element) return;
    if (!reduced) {
      gsap.from(element, { opacity: 0, y: DISTANCE.rise * 2, duration: DURATION.base, ease: EASE.out });
      const tick = element.querySelector(".toast__tick path");
      if (tick) gsap.fromTo(tick, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: DURATION.draw / 2, delay: 0.1, ease: EASE.out });
    }
    timer.current = setTimeout(() => onDismiss(toast.id), TOAST_DURATION_MS);
    return () => clearTimeout(timer.current);
  }, []);

  // Exit: fade and drop, then ask the provider to remove it.
  useGsap(ref, ({ reduced }) => {
    if (!toast.leaving) return;
    clearTimeout(timer.current);
    if (reduced || !ref.current) {
      onGone(toast.id);
      return;
    }
    gsap.to(ref.current, { opacity: 0, y: DISTANCE.rise, duration: DURATION.fast, ease: EASE.soft, onComplete: () => onGone(toast.id) });
  }, [toast.leaving]);

  return (
    <div ref={ref} className={`toast toast--${toast.tone}`} role="status">
      <span className="toast__icon" aria-hidden="true">
        {toast.tone === "success" ? (
          <svg className="toast__tick" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L19 7" pathLength="1" strokeDasharray="1" />
          </svg>
        ) : <Info size={16} />}
      </span>
      <span className="toast__message">{toast.message}</span>
      <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
};

// Outcome toasts: "Leave approved", "Payroll processed". They confirm what the server has already done, so there is no Undo.
const ToastProvider = ({ children }) => {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const nextId = useRef(0);

  const show = useCallback((tone, message) => {
    nextId.current += 1;
    dispatch({ type: "add", toast: { id: nextId.current, tone, message, leaving: false } });
  }, []);
  const dismiss = useCallback((id) => dispatch({ type: "leave", id }), []);
  const remove = useCallback((id) => dispatch({ type: "remove", id }), []);

  const api = useMemo(() => ({
    success: (message) => show("success", message),
    info: (message) => show("info", message),
    dismiss,
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" aria-live="polite" aria-label="Notifications">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} onGone={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export default ToastProvider;
