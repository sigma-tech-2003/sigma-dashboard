import { useRef } from "react";
import { useCountUp } from "../../hooks/motion/useCountUp";

// A figure that counts up from zero when it first appears ("PKR 326,100", "8", "7.5"). The text in the DOM is always the
// real value, so assistive tech and copy-paste see it; only the on-screen digits move, and not at all with reduced motion.
const CountUp = ({ value, className, as: Tag = "span" }) => {
  const ref = useRef(null);
  useCountUp(ref, value);

  return <Tag ref={ref} className={className}>{value}</Tag>;
};

export default CountUp;
