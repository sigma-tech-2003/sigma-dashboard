import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// True when the person has asked their system for less motion. Takes matchMedia as an argument so it can be tested.
export const prefersReducedMotion = (matchMedia) => Boolean(matchMedia?.(QUERY)?.matches);

const subscribe = (notify) => {
  const query = window.matchMedia?.(QUERY);
  query?.addEventListener?.("change", notify);
  return () => query?.removeEventListener?.("change", notify);
};

export const useReducedMotion = () =>
  useSyncExternalStore(
    subscribe,
    () => prefersReducedMotion(window.matchMedia?.bind(window)),
    () => false,
  );
