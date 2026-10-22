import "./ProgressBar.css";
import { useRef } from "react";
import { T } from "../../theme/theme";
import { DURATION, EASE } from "../../theme/motion";
import { gsap, useGsap } from "../../hooks/motion/useGsap";

// A flat bar: a solid fill on the border colour. The fill is scaled, not resized, so filling and changing never reflow.
// It starts empty and fills the first time it is on screen, so a bar far down a page is not already full when you
// scroll to it. `label` names it for assistive tech ("Q1 sales target progress").
const ProgressBar = ({ value, max = 100, color = T.primary, h = 6, label }) => {
  const fillRef = useRef(null);
  const raw = max > 0 ? Math.round((value / max) * 100) : 0;
  const p = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));

  const ctxRef = useGsap(fillRef, ({ reduced, scope }) => {
    if (reduced || !scope || typeof IntersectionObserver === "undefined") return undefined;

    gsap.set(scope, { scaleX: 0 });
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      ctxRef.current?.add(() => gsap.to(scope, { scaleX: p / 100, duration: DURATION.draw, ease: EASE.out }));
    }, { root: scope.closest(".content"), threshold: 0.2 });
    observer.observe(scope.parentElement);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label || "Progress"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p}
      style={{ height: h }}
    >
      <div
        ref={fillRef}
        className="progress-inner"
        style={{ transform: `scaleX(${p / 100})`, background: color }}
      />
    </div>
  );
};

export default ProgressBar;
