import { useRef } from "react";
import { DURATION, EASE } from "../../theme/motion";
import { gsap, useGsap } from "./useGsap";

// One highlight element that slides to whichever child is active, instead of each child fading its own background.
// The container needs `position: relative`, a child with `data-indicator`, and the active child marked
// `data-active="true"`. Only `x` or `y` is animated, so the slide is a transform and never a layout change. On first
// paint (and when motion is reduced) it is placed without sliding.
// The context is reverted whenever the active item changes, which clears the indicator's transform; the last position
// is kept in a ref and put back first, so the slide starts where the highlight was and not from the top.
export const useSlidingIndicator = (containerRef, activeKey, axis = "y") => {
  const previousKey = useRef(undefined);
  const lastPosition = useRef(undefined);
  const property = axis === "x" ? "x" : "y";

  useGsap(containerRef, ({ reduced }) => {
    const root = containerRef.current;
    const indicator = root?.querySelector("[data-indicator]");
    const active = root?.querySelector('[data-active="true"]');
    if (!indicator) return;

    if (!active) {
      gsap.set(indicator, { opacity: 0 });
      previousKey.current = activeKey;
      return;
    }

    const place = () => (axis === "x" ? active.offsetLeft : active.offsetTop);
    const position = place();
    const from = lastPosition.current;
    const slide = previousKey.current !== undefined && previousKey.current !== activeKey && !reduced && from !== undefined;
    previousKey.current = activeKey;
    lastPosition.current = position;

    gsap.set(indicator, { opacity: 1, [property]: slide ? from : position });
    if (slide) gsap.to(indicator, { [property]: position, duration: DURATION.base, ease: EASE.out });

    // A container that was hidden or resized (the theme control is hidden on a phone) re-places the indicator, unanimated.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      lastPosition.current = place();
      gsap.set(indicator, { [property]: lastPosition.current });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [activeKey]);
};
