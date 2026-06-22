import "./LoadingScreen.css";
import { T } from "../../theme/theme";
import { Briefcase } from "lucide-react";

const LoadingScreen = ({ message = "Loading…" }) => (
  <div
    className="loading-screen"
    style={{ background: T.bg }}
  >
    <div
      className="loading-icon"
      style={{
        background: `linear-gradient(135deg,${T.primary},${T.purple})`,
      }}
    >
      <Briefcase size={22} color="#fff" />
    </div>

    <div
      className="loading-text"
      style={{ color: T.muted }}
    >
      {message}
    </div>

    <div
      className="loading-bar"
      style={{ background: T.border }}
    >
      <div
        className="loading-bar-inner"
        style={{ background: T.primary }}
      />
    </div>
  </div>
);

export default LoadingScreen;