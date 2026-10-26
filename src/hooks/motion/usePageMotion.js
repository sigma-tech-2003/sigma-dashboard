import { DISTANCE, DURATION, EASE, MAX_ENTRANCE_TARGETS, MAX_SCROLL_REVEALS, SCROLL_START, STAGGER } from "../../theme/motion";
import { pickAboveFold } from "../../utils/motionMath";
import { gsap, ScrollTrigger, useGsap } from "./useGsap";

// What a page animates when it arrives: its heading, stat cards, filters and first table or card grid.
const ENTRANCE_SELECTOR = [
  ".page-header",
  ".login-header",
  ".login-card",
  ".dash-date",
  ".dash-lede",
  ".stat-grid > *",
  ".filter-bar",
  ".data-table-container",
  ".table-skeleton",
  ".empty-state",
  ".section-head",
  ".kpi-summary > *",
  ".kpi-grid > *",
  ".payslip-grid > *",
  ".dash-grid > *",
  ".report-grid > *",
  ".report-section",
].join(", ");

// Entrance for what is on screen when the page opens, ScrollTrigger reveals for sections marked data-reveal as they
// scroll into view. Only opacity and a small transform move, so nothing reflows. The scroll container is `.content`
// (the app scrolls that, not the window), and every trigger fires once.
export const usePageMotion = (scopeRef) => {
  useGsap(scopeRef, ({ reduced }) => {
    const root = scopeRef.current;
    if (reduced || !root) return;

    const scroller = root.closest(".content");
    const viewportBottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;

    // Sections that reveal on scroll handle themselves; elements nested inside another target move with it.
    const candidates = [...root.querySelectorAll(ENTRANCE_SELECTOR)].filter((element) => !element.closest("[data-reveal]"));
    const outermost = candidates.filter((element) => !candidates.some((other) => other !== element && other.contains(element)));
    const picked = pickAboveFold(outermost.map((element) => element.getBoundingClientRect().top), viewportBottom, MAX_ENTRANCE_TARGETS);

    // A page with a greeting (the dashboard) brings its words in one after another first; the rest follows them.
    const words = [...root.querySelectorAll("[data-word]")];
    if (words.length > 0) {
      gsap.from(words, { opacity: 0, y: DISTANCE.rise * 2, duration: DURATION.slow, ease: EASE.out, stagger: STAGGER.base + 0.02, clearProps: "opacity,transform" });
    }

    if (picked.length > 0) {
      gsap.from(picked.map((index) => outermost[index]), {
        opacity: 0,
        y: DISTANCE.rise,
        duration: DURATION.entrance,
        ease: EASE.out,
        stagger: STAGGER.tight,
        delay: words.length > 0 ? 0.2 : 0,
        clearProps: "opacity,transform",
      });
    }

    [...root.querySelectorAll("[data-reveal]")].slice(0, MAX_SCROLL_REVEALS).forEach((section) => {
      gsap.from(section, {
        opacity: 0,
        y: DISTANCE.rise + 4,
        duration: DURATION.entrance,
        ease: EASE.out,
        clearProps: "opacity,transform",
        // Passed as the element, not the string ".content": inside a gsap.context a selector only searches the scope,
        // and the scroll container is the scope's ancestor.
        scrollTrigger: { trigger: section, scroller: scroller ?? window, start: SCROLL_START, once: true },
      });
    });

    // Lazy charts and fonts can move things after the first layout; measure the triggers again once it settles.
    const frame = requestAnimationFrame(() => ScrollTrigger.refresh());
    return () => cancelAnimationFrame(frame);
  }, []);
};
