import "./DensityToggle.css";
import { Rows3, Rows4 } from "lucide-react";
import { useDensity } from "../../hooks/useDensity";

// Comfortable or compact table rows. A switch: pressed means compact.
const DensityToggle = () => {
  const [density, setDensity] = useDensity();
  const compact = density === "compact";

  return (
    <button
      type="button"
      className="density-toggle"
      role="switch"
      aria-checked={compact}
      aria-label="Compact rows"
      title={compact ? "Compact rows: on" : "Compact rows: off"}
      onClick={() => setDensity(compact ? "comfortable" : "compact")}
    >
      {compact ? <Rows4 size={16} aria-hidden="true" /> : <Rows3 size={16} aria-hidden="true" />}
    </button>
  );
};

export default DensityToggle;
