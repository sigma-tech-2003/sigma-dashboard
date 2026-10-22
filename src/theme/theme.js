// JavaScript access to the design tokens. The values live ONLY in tokens.css (dark by default, light under
// [data-theme="light"]); every entry here is a var(...) reference to one of them. That is why a theme switch needs no
// re-render, and why there is no second copy of any colour to keep in step.
//
// Names are the ones the components already use. Where a component needs a colour with transparency, use alpha():
// appending hex digits (`${T.primary}30`) does not work on a variable.

const color = (name) => `var(--color-${name})`;

export const T = {
  bg: color("bg"),
  surface: color("surface"),
  card: color("card"),
  cardHover: color("card-hover"),
  raised: color("raised"),
  sidebar: color("sidebar"),
  sidebarBorder: color("sidebar-border"),

  border: color("border"),
  borderLight: color("border-light"),
  borderControl: color("border-control"),

  text: color("text"),
  mutedLight: color("muted-light"),
  muted: color("muted"),

  primary: color("primary"),
  primaryHover: color("primary-hover"),
  primaryText: color("primary-text"),
  primaryGlow: color("primary-glow"),
  primaryTint: color("primary-tint"),

  secondary: color("secondary"),
  secondaryGlow: color("secondary-glow"),
  success: color("success"),
  successFill: color("success-fill"),
  onSuccess: color("on-success"),
  successGlow: color("success-glow"),
  warning: color("warning"),
  warningFill: color("warning-fill"),
  onWarning: color("on-warning"),
  warningGlow: color("warning-glow"),
  warningTint: color("warning-tint"),
  danger: color("danger"),
  dangerFill: color("danger-fill"),
  onDanger: color("on-danger"),
  dangerGlow: color("danger-glow"),
  purple: color("purple"),
  purpleGlow: color("purple-glow"),
  mutedGlow: color("muted-glow"),

  white: color("white"),
  black: color("black"),
  overlay: color("overlay"),
};

/** `value` (a T colour or any CSS colour) at `percent` opacity, as a CSS colour. */
export const alpha = (value, percent) => `color-mix(in srgb, ${value} ${percent}%, transparent)`;

/**
 * Kept so existing callers keep working. The theme is chosen by data-theme on <html> (AppProvider sets it) and the
 * colours resolve in CSS, so there is nothing to copy any more.
 */
export const setThemePalette = () => T;
