import { DURATION, EASE } from "../../theme/motion";
import { formatCountable, parseCountable } from "../../utils/motionMath";
import { gsap, useGsap } from "./useGsap";

// Counts the figure inside `ref` up from zero when the component mounts. React owns the text node, so the count writes to
// that same node (not textContent, which would replace it) and any later change from React still lands. The text is always
// put back to exactly `value` when the count ends or is cancelled.
export const useCountUp = (ref, value) => {
  useGsap(ref, ({ reduced, scope }) => {
    const node = scope?.firstChild;
    const parsed = parseCountable(value);
    if (reduced || !parsed || node?.nodeType !== Node.TEXT_NODE) return;

    const state = { progress: 0 };
    node.nodeValue = formatCountable(parsed, 0);
    gsap.to(state, {
      progress: 1,
      duration: DURATION.count,
      ease: EASE.out,
      onUpdate: () => {
        node.nodeValue = formatCountable(parsed, state.progress);
      },
    });

    return () => {
      node.nodeValue = String(value);
    };
  }, []);
};
