import { useRef } from "react";
import { DURATION, EASE } from "../../theme/motion";
import { gsap, useGsap } from "./useGsap";

// A short pop when `key` changes after first render (a status going from Pending to Approved). Not on mount: a table full
// of badges does not animate when it opens, only the one that changed.
export const useChangePulse = (ref, key) => {
  const previousKey = useRef(key);

  useGsap(ref, ({ reduced }) => {
    const changed = previousKey.current !== key;
    previousKey.current = key;
    if (!changed || reduced || !ref.current) return;
    gsap.from(ref.current, { scale: 0.86, opacity: 0.35, duration: DURATION.base, ease: EASE.out, clearProps: "transform,opacity" });
  }, [key]);
};
