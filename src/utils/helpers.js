export const fmt  = (n) => `PKR ${Number(n||0).toLocaleString()}`;
export const pct  = (c, t) => Math.min(100, Math.round((c / t) * 100));
export const fdate= (d) => d ? new Date(d).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}) : "—";
export const AVATAR_PALETTE = ["#1d6fec","#8b5cf6","#f04060","#00cc88","#f0a500","#00c2cb","#e55d87","#5fc3e4"];
export const aColor = (id) => AVATAR_PALETTE[(id - 1) % AVATAR_PALETTE.length];
export const initials = (name) => name?.split(" ").map(n => n[0]).join("").toUpperCase().slice(0,2) || "??";
export const kpiScore = (kpis) => {
  if (!kpis.length) return 0;
  const weighted = kpis.reduce((s, k) => s + (pct(k.current, k.target) * k.weight), 0);
  const totalW   = kpis.reduce((s, k) => s + k.weight, 0);
  return totalW ? Math.round(weighted / totalW) : 0;
};

// Score labels based on thresholds: Excellent (90-100), Good (75-89), Average (60-74), Poor (0-59).
export const perfLabel = (score) => score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Average" : "Poor";

// Color coding for performance scores: green for excellent, blue for good, orange for average, and red for poor.
export const perfColor = (score) => score >= 90 ? T.success : score >= 75 ? T.secondary : score >= 60 ? T.warning : T.danger;
import { T } from "../theme/theme";

// Tax slabs:
export const calcTax   = (gross) => gross <= 50000 ? 0 : gross <= 100000 ? (gross - 50000) * 0.05 : gross <= 200000 ? 2500 + (gross - 100000) * 0.10 : 12500 + (gross - 200000) * 0.15;