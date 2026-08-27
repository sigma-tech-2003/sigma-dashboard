const darkColors = {
  bg: "#05080f",
  surface: "#0a1020",
  card: "#0e1628",
  cardHover: "#111d32",
  border: "#1a2740",
  borderLight: "#1e3050",
  primary: "#1d6fec",
  primaryGlow: "#1d6fec30",
  primaryTint: "#1d6fec20",
  secondary: "#00c2cb",
  secondaryGlow: "#00c2cb20",
  success: "#00cc88",
  successGlow: "#00cc8820",
  warning: "#f0a500",
  warningGlow: "#f0a50020",
  warningTint: "#f0a50015",
  danger: "#f04060",
  dangerGlow: "#f0406020",
  purple: "#8b5cf6",
  purpleGlow: "#8b5cf620",
  text: "#dde8ff",
  muted: "#5a7499",
  mutedGlow: "#5a749920",
  mutedLight: "#7a94b8",
  sidebar: "#070c18",
  sidebarBorder: "#0f1e35",
  white: "#fff",
  black: "#000",
  overlay: "#000000aa",
};

const lightColors = {
  bg: "#f4f7fb",
  surface: "#ffffff",
  card: "#ffffff",
  cardHover: "#f7f9fc",
  border: "#dbe3ee",
  borderLight: "#cbd7e6",
  primary: "#175cd3",
  primaryGlow: "#175cd324",
  primaryTint: "#e8f0fe",
  secondary: "#087f8c",
  secondaryGlow: "#087f8c1a",
  success: "#087a55",
  successGlow: "#087a5518",
  warning: "#b54708",
  warningGlow: "#b5470818",
  warningTint: "#fff4e5",
  danger: "#c4324f",
  dangerGlow: "#c4324f18",
  purple: "#6941c6",
  purpleGlow: "#6941c618",
  text: "#172033",
  muted: "#66758a",
  mutedGlow: "#66758a18",
  mutedLight: "#52657d",
  sidebar: "#ffffff",
  sidebarBorder: "#dbe3ee",
  white: "#fff",
  black: "#000",
  overlay: "#0f172a66",
};

export const THEME_PALETTES = {
  dark: darkColors,
  light: lightColors,
};

export const T = { ...darkColors };

export const setThemePalette = (theme = "dark") => {
  Object.assign(T, THEME_PALETTES[theme] || darkColors);
  return T;
};

export const designTokens = {
  colors: T,
  typography: {
    fontFamily: "'Outfit', sans-serif",
    fontSize: {
      xs: 11,
      sm: 12,
      md: 13,
      lg: 14,
      xl: 15,
      "2xl": 16,
      "3xl": 20,
      "4xl": 26,
      "5xl": 28,
    },
    fontWeight: {
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
    },
  },
  spacing: {
    1: 4,
    2: 6,
    3: 8,
    4: 10,
    5: 12,
    6: 14,
    7: 16,
    8: 20,
    9: 24,
    10: 32,
    11: 48,
  },
  radius: {
    sm: 6,
    md: 8,
    lg: 10,
    xl: 12,
    "2xl": 14,
    "3xl": 16,
    pill: 999,
  },
  shadow: {
    card: "0 0 0 1px #1a2740",
  },
  transition: {
    fast: "0.15s ease",
    base: "0.2s ease",
    progress: "0.4s ease",
  },
  zIndex: {
    modal: 1000,
  },
  breakpoints: {
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
  },
  components: {
    button: {
      small: { padding: "6px 12px", fontSize: 11 },
      medium: { padding: "8px 16px", fontSize: 13 },
    },
    form: {
      control: { padding: "9px 12px", fontSize: 13 },
      label: { fontSize: 12 },
    },
    card: {
      borderRadius: 12,
      padding: 20,
    },
    table: {
      cellPadding: "12px 16px",
      headerFontSize: 11,
    },
    modal: {
      padding: 24,
      maxHeight: "90vh",
    },
  },
};
