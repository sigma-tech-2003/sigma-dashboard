import { DURATION, EASE } from "../../theme/motion";
import { gsap, useGsap } from "./useGsap";

// One highlight bar that follows the pointer (or keyboard focus) down a table's rows. Only where there is a real pointer
// and room for a table, and never when motion is reduced: on a phone the rows are cards, and a hover highlight means
// nothing under a finger. The bar moves with a transform; its height is set once per row, and it is absolutely
// positioned, so nothing around it reflows.
export const useRowHighlight = (containerRef, key) => {
  useGsap(containerRef, () => {
    const root = containerRef.current;
    if (!root) return;

    const media = gsap.matchMedia();
    media.add("(hover: hover) and (min-width: 640px) and (prefers-reduced-motion: no-preference)", () => {
      const bar = root.querySelector("[data-row-highlight]");
      if (!bar || !root.querySelector("tbody")) return;

      root.classList.add("has-row-highlight");
      let visible = false;

      const moveTo = (row) => {
        const rowBox = row.getBoundingClientRect();
        const rootBox = root.getBoundingClientRect();
        const y = rowBox.top - rootBox.top;
        bar.style.height = `${rowBox.height}px`;
        if (visible) {
          gsap.to(bar, { y, duration: DURATION.fast, ease: EASE.out, overwrite: true });
        } else {
          gsap.set(bar, { y });
          gsap.to(bar, { opacity: 1, duration: DURATION.fast });
          visible = true;
        }
      };
      const hide = () => {
        visible = false;
        gsap.to(bar, { opacity: 0, duration: DURATION.fast });
      };
      const onOver = (event) => {
        const row = event.target.closest?.("tbody tr");
        if (row && root.contains(row)) moveTo(row);
      };

      root.addEventListener("pointerover", onOver);
      root.addEventListener("focusin", onOver);
      root.addEventListener("pointerleave", hide);
      root.addEventListener("focusout", hide);

      return () => {
        root.removeEventListener("pointerover", onOver);
        root.removeEventListener("focusin", onOver);
        root.removeEventListener("pointerleave", hide);
        root.removeEventListener("focusout", hide);
        root.classList.remove("has-row-highlight");
      };
    });
  }, [key]);
};
