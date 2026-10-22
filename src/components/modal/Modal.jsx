import "./Modal.css";
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useModalMotion } from "../../hooks/motion/useModalMotion";
import { nextFocusIndex, shouldCloseOnBackdrop } from "./modalBehavior";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A dialog: named, modal, Escape closes it, Tab stays inside it, focus returns to whatever opened it. On a phone it is a
// bottom sheet. The backdrop closes it only until something has been typed into it. Opening and closing are animated
// (useModalMotion); with reduced motion they are instant.
const Modal = ({ title, onClose, children, wide }) => {
  const titleId = useId();
  const overlayRef = useRef(null);
  const boxRef = useRef(null);
  const pressStartedOnBackdrop = useRef(false);
  const dirty = useRef(false);
  const requestClose = useModalMotion(overlayRef, boxRef);

  const close = () => requestClose(() => onClose?.());

  useEffect(() => {
    const opener = document.activeElement;
    const box = boxRef.current;
    const first = box.querySelector(".modal-body")?.querySelector(FOCUSABLE);
    (first || box).focus();
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const items = [...boxRef.current.querySelectorAll(FOCUSABLE)];
    const target = nextFocusIndex({ count: items.length, current: items.indexOf(document.activeElement), shift: event.shiftKey });
    if (target !== null) {
      event.preventDefault();
      items[target].focus();
    }
  };

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && shouldCloseOnBackdrop({ pressStartedOnBackdrop: pressStartedOnBackdrop.current, dirty: dirty.current })) {
          close();
        }
      }}
    >
      <div
        ref={boxRef}
        className={"modal-box" + (wide ? " modal-box--wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onInput={() => {
          dirty.current = true;
        }}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">{title}</h2>

          <button type="button" className="modal-close" onClick={close} aria-label="Close dialog">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
};

export default Modal;
