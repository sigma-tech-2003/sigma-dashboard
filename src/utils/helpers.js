import { T } from "../theme/theme";

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

export const AVATAR_PALETTE = [
  "#1d6fec",
  "#8b5cf6",
  "#f04060",
  "#00cc88",
  "#f0a500",
  "#00c2cb",
  "#e55d87",
  "#5fc3e4",
];

export const aColor = (id) =>
  AVATAR_PALETTE[(id - 1) % AVATAR_PALETTE.length];

export const initials = (name) =>
  name?.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2) || "??";

export const PROJECT_KPI_SCORE_MIN = 1;
export const PROJECT_KPI_SCORE_MAX = 10;
export const PROJECT_KPI_NOT_RATED_LABEL = "Not Rated";
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
