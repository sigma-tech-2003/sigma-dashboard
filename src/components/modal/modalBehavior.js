// The two decisions a dialog makes that are worth testing without a DOM.

// A click on the dimmed backdrop closes the dialog, but never when it would throw work away. The press has to start on the
// backdrop too (so selecting text inside the dialog and releasing outside does not close it), and once the person has typed
// into the dialog the backdrop stops being a way out: Escape and the close button still are.
export const shouldCloseOnBackdrop = ({ pressStartedOnBackdrop, dirty }) => Boolean(pressStartedOnBackdrop) && !dirty;

// Tab wraps inside the dialog. Returns the index to focus next, or null to let the browser move focus normally.
export const nextFocusIndex = ({ count, current, shift }) => {
  if (count === 0) return null;
  if (shift && current <= 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
};
