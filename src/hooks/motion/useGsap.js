import { useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { prefersReducedMotion } from "../useReducedMotion";

gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };

// The one place a GSAP context is made. Every animation in the app goes through here:
//   component -> useLayoutEffect -> gsap.context() -> GSAP / ScrollTrigger
// `setup({ reduced, scope })` runs once per dependency change, scoped to `scopeRef` (so selectors only see this component's
// own elements), and everything it creates -- tweens, ScrollTriggers, matchMedia -- is reverted on unmount or change.
// `scope` is the scoped element itself. `reduced` is true when the person asked their system for less motion: setups put things in their end state and return.
// Returns a ref to the live context, so an event handler can add a tween that is cleaned up with the component:
//   ctxRef.current.add(() => gsap.to(...))
export const useGsap = (scopeRef, setup, deps) => {
  const ctxRef = useRef(null);

  useLayoutEffect(() => {
    const reduced = prefersReducedMotion(window.matchMedia?.bind(window));
    const ctx = gsap.context(() => setup({ reduced, scope: scopeRef?.current ?? null }), scopeRef);
    ctxRef.current = ctx;
    return () => {
      ctx.revert();
      ctxRef.current = null;
    };
    // The caller owns the dependency list: setups are written to run once per mount or per the keys they name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ctxRef;
};
