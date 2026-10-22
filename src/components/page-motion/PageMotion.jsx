import { useRef } from "react";
import { usePageMotion } from "../../hooks/motion/usePageMotion";

// Wraps one page. Mounted inside the Suspense boundary and keyed by route, so it runs when the page's content has
// rendered: the heading and first blocks rise in, and sections marked data-reveal reveal as they scroll into view.
const PageMotion = ({ children }) => {
  const ref = useRef(null);
  usePageMotion(ref);

  return <div ref={ref} className="page-motion">{children}</div>;
};

export default PageMotion;
