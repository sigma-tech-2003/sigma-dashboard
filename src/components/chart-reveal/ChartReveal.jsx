import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion";

const CAN_OBSERVE = typeof IntersectionObserver !== "undefined";

// Holds a chart's place and mounts it when it scrolls into view, so its own draw-in animation plays where the person can
// see it instead of finishing off-screen. `height` keeps the space reserved, so nothing shifts when the chart arrives.
// With reduced motion, or where IntersectionObserver is missing, it renders at once.
const ChartReveal = ({ height, children }) => {
  const ref = useRef(null);
  const reduced = useReducedMotion();
  const [seen, setSeen] = useState(false);
  const show = seen || reduced || !CAN_OBSERVE;

  useEffect(() => {
    const element = ref.current;
    if (show || !element) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    }, { root: element.closest(".content"), rootMargin: "0px 0px -8% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [show]);

  return (
    <div ref={ref} style={{ minHeight: height }}>
      {show ? children : null}
    </div>
  );
};

export default ChartReveal;
