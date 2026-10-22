// Durations (seconds), eases and distances for every animation in the app. Numbers and GSAP ease names only: colours
// always come from the theme tokens, never from here. CSS transitions read the matching --dur-* / --ease-* in tokens.css.
export const DURATION = {
  fast: 0.15,
  base: 0.25,
  entrance: 0.35,
  slow: 0.5,
  count: 0.9,
  draw: 0.8,
};

export const EASE = {
  out: "power3.out",
  inOut: "power2.inOut",
  soft: "power2.out",
};

export const STAGGER = {
  tight: 0.04,
  base: 0.06,
};

export const DISTANCE = {
  rise: 8,
  sheet: 40,
};

// Page entrances animate at most this many elements; the rest simply appear.
export const MAX_ENTRANCE_TARGETS = 14;
// Scroll reveals per page. Each is one ScrollTrigger, so the number is capped.
export const MAX_SCROLL_REVEALS = 6;
export const SCROLL_START = "top 92%";
