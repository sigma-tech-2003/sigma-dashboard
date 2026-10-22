// The arithmetic behind the animations, kept free of the DOM and of GSAP so it can be tested.

// "PKR 239,345", "9", "7.5/10", "50%" and "0/9" have a number to count up to; "Not rated" and "—" do not.
// Only the first number is counted; the text around it is kept exactly as written.
const COUNTABLE = /^(\D*?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(.*)$/;

export const parseCountable = (value) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const decimals = (String(value).split(".")[1] || "").length;
    return { prefix: "", target: value, decimals, grouped: false, suffix: "" };
  }
  if (typeof value !== "string") return null;
  const match = COUNTABLE.exec(value);
  if (!match) return null;
  const [, prefix, whole, fraction = "", suffix] = match;
  const grouped = whole.includes(",");
  return {
    prefix,
    target: Number(`${whole.replace(/,/g, "")}${fraction}`),
    decimals: fraction ? fraction.length - 1 : 0,
    grouped,
    suffix,
  };
};

// The text to show when the count is `progress` (0 to 1) of the way there. At 1 it is exactly the original text.
export const formatCountable = (parsed, progress) => {
  const clamped = Math.min(1, Math.max(0, progress));
  const current = parsed.target * clamped;
  const rounded = parsed.decimals ? Number(current.toFixed(parsed.decimals)) : Math.round(current);
  const body = parsed.grouped
    ? rounded.toLocaleString("en-US", { minimumFractionDigits: parsed.decimals, maximumFractionDigits: parsed.decimals })
    : parsed.decimals
      ? rounded.toFixed(parsed.decimals)
      : String(rounded);
  return `${parsed.prefix}${body}${parsed.suffix}`;
};

// Which of these boxes get an entrance animation: the ones that start inside the visible area, in document order, up to
// `cap`. Anything below the fold just appears, because animating what nobody can see is wasted work.
export const pickAboveFold = (tops, viewportBottom, cap) => {
  const picked = [];
  for (let index = 0; index < tops.length && picked.length < cap; index += 1) {
    if (tops[index] < viewportBottom) picked.push(index);
  }
  return picked;
};
