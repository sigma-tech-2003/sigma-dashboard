import { T } from "../theme/theme.js";
import { prefersReducedMotion } from "../hooks/useReducedMotion.js";

// Shared recharts styling, read from the theme tokens so charts follow dark and light with no second palette.
export const tooltipStyle = {
  background: T.raised,
  border: `1px solid ${T.border}`,
  borderRadius: 8,
  color: T.text,
  fontSize: 13,
};

export const axisTick = { fill: T.muted, fontSize: 12 };

// The hover cursor behind a bar or along an area. recharts paints it light grey unless told otherwise, which is a bright
// block on the dark theme.
export const chartCursor = { fill: T.cardHover, stroke: T.borderLight };

export const shortLabel = (value, max = 10) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// recharts draws its series in with its own animation. This turns it off for people who asked for less motion and sets
// one duration and ease for every chart. Spread it onto each <Area>, <Bar> and <Pie>.
export const chartMotion = () => ({
  isAnimationActive: !prefersReducedMotion(typeof window === "undefined" ? undefined : window.matchMedia?.bind(window)),
  animationDuration: 700,
  animationEasing: "ease-out",
});
