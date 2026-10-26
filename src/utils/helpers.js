import { T } from "../theme/theme.js";

export const fmt = (number) => `PKR ${Number(number || 0).toLocaleString()}`;

export const pct = (current, total) =>
  Math.min(100, Math.round((current / total) * 100));

export const fdate = (date) =>
  date
    ? new Date(date).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

// Avatar fills. Each is dark enough for white initials at 4.5:1 or better (checked in helpers.test.js), so one palette
// serves both themes.
export const AVATAR_PALETTE = [
  "#3e6fe6",
  "#7c4dd6",
  "#c93a54",
  "#0f7a52",
  "#b54708",
  "#077784",
  "#b8336a",
  "#4a5fa8",
];

// Ids are UUID strings, so the colour comes from a hash of the id: the same person always gets the same colour.
export const aColor = (id) => {
  const text = String(id ?? "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
};

export const initials = (name) =>
  name?.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2) || "??";

export const PROJECT_KPI_SCORE_MIN = 1;
export const PROJECT_KPI_SCORE_MAX = 10;
export const PROJECT_KPI_NOT_RATED_LABEL = "Not rated";
export const PROJECT_KPI_RATING_LABELS = Object.freeze({
  POOR: "Poor",
  NEEDS_IMPROVEMENT: "Needs Improvement",
  GOOD: "Good",
  VERY_GOOD: "Very Good",
  EXCELLENT: "Excellent",
});

export const isValidProjectKpiScore = (score) => {
  if (score == null || (typeof score === "string" && score.trim() === "")) return false;
  if (typeof score !== "number" && typeof score !== "string") return false;
  if (typeof score === "string" && !/^\d+$/.test(score.trim())) return false;

  const numericScore = Number(score);
  return Number.isInteger(numericScore)
    && numericScore >= PROJECT_KPI_SCORE_MIN
    && numericScore <= PROJECT_KPI_SCORE_MAX;
};

export const getProjectKpiRatingLabel = (score) => {
  if (!isValidProjectKpiScore(score)) return PROJECT_KPI_NOT_RATED_LABEL;

  const numericScore = Number(score);
  if (numericScore <= 3) return PROJECT_KPI_RATING_LABELS.POOR;
  if (numericScore <= 5) return PROJECT_KPI_RATING_LABELS.NEEDS_IMPROVEMENT;
  if (numericScore <= 7) return PROJECT_KPI_RATING_LABELS.GOOD;
  if (numericScore <= 9) return PROJECT_KPI_RATING_LABELS.VERY_GOOD;
  return PROJECT_KPI_RATING_LABELS.EXCELLENT;
};

export const getKpiRatingSummary = (kpis) => {
  const records = Array.isArray(kpis) ? kpis : [];
  const validRatings = records
    .map((kpi) => kpi?.rating)
    .filter(isValidProjectKpiScore)
    .map(Number);
  const ratedCount = validRatings.length;

  return {
    average: ratedCount
      ? Math.round((validRatings.reduce((sum, rating) => sum + rating, 0) / ratedCount) * 10) / 10
      : null,
    ratedCount,
    totalCount: records.length,
  };
};

export const kpiScore = (kpis) => {
  if (!kpis.length) return 0;

  const weighted = kpis.reduce(
    (sum, kpi) => sum + pct(kpi.current, kpi.target) * kpi.weight,
    0,
  );
  const totalWeight = kpis.reduce((sum, kpi) => sum + kpi.weight, 0);

  return totalWeight ? Math.round(weighted / totalWeight) : 0;
};

export const perfLabel = (score) =>
  score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Average" : "Poor";

export const perfColor = (score) =>
  score >= 90 ? T.success : score >= 75 ? T.secondary : score >= 60 ? T.warning : T.danger;

export const calcTax = (gross) =>
  gross <= 50000
    ? 0
    : gross <= 100000
      ? (gross - 50000) * 0.05
      : gross <= 200000
        ? 2500 + (gross - 100000) * 0.1
        : 12500 + (gross - 200000) * 0.15;
