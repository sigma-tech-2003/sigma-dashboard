import { useCallback, useRef } from "react";
import { prefersReducedMotion } from "../useReducedMotion";
import { DISTANCE, DURATION, EASE } from "../../theme/motion";
import { gsap, useGsap } from "./useGsap";

const PHONE = "(max-width: 639px)";

// A dialog opens with a short fade and rise (a slide-up sheet on a phone) and closes the same way in reverse. Closing is
// `requestClose(done)`: it plays the exit and then calls `done`, so the dialog is not removed while it is still moving.
// With reduced motion both are instant. Focus handling stays in Modal.jsx; this only moves the box.
export const useModalMotion = (overlayRef, boxRef) => {
  const closing = useRef(false);

  const ctxRef = useGsap(overlayRef, ({ reduced }) => {
    const overlay = overlayRef.current;
    const box = boxRef.current;
    if (reduced || !overlay || !box) return;

    const media = gsap.matchMedia();
    media.add(PHONE, () => {
      gsap.from(overlay, { opacity: 0, duration: DURATION.fast, ease: EASE.soft, clearProps: "opacity" });
      gsap.from(box, { yPercent: 100, duration: DURATION.entrance - 0.05, ease: EASE.out, clearProps: "transform" });
    });
    media.add("(min-width: 640px)", () => {
      gsap.from(overlay, { opacity: 0, duration: DURATION.fast, ease: EASE.soft, clearProps: "opacity" });
      gsap.from(box, { opacity: 0, y: DISTANCE.rise + 4, scale: 0.98, duration: DURATION.base, ease: EASE.out, clearProps: "opacity,transform" });
    });
  }, []);

  const requestClose = useCallback((done) => {
    if (closing.current) return;
    closing.current = true;

    const overlay = overlayRef.current;
    const box = boxRef.current;
    const finish = () => {
      closing.current = false;
      done();
    };
    if (!overlay || !box || !ctxRef.current || prefersReducedMotion(window.matchMedia?.bind(window))) {
      finish();
      return;
    }

    const sheet = window.matchMedia(PHONE).matches;
    ctxRef.current.add(() => {
      gsap.to(box, sheet
        ? { yPercent: 100, duration: DURATION.fast + 0.05, ease: EASE.inOut }
        : { opacity: 0, y: DISTANCE.rise, scale: 0.98, duration: DURATION.fast, ease: EASE.soft });
      gsap.to(overlay, { opacity: 0, duration: DURATION.fast, ease: EASE.soft, onComplete: finish });
    });
  }, [overlayRef, boxRef, ctxRef]);

  return requestClose;
};
