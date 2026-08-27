import { Bell, Menu, Palette } from "lucide-react";
import { useApp } from "../../app/useApp";
import { T } from "../../theme/theme";
import Avatar from "../avatar/Avatar";

const Breadcrumbs = ({ items }) => {
  if (!items?.length) return null;

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={item.label} className="breadcrumbs__item">
          {index > 0 && <span className="breadcrumbs__separator">/</span>}
          {item.label}
        </span>
      ))}
    </nav>
  );
};

const Topbar = ({ user, pageTitle, breadcrumbs, onMenuToggle }) => {
  const { themePreference, setThemePreference } = useApp();

  return (
    <header
      className="topbar"
      style={{
        background: T.surface,
        borderBottom: "1px solid " + T.border,
      }}
    >
      <button
        type="button"
        onClick={onMenuToggle}
        className="topbar-menu-button"
        aria-label="Toggle navigation"
        style={{ color: T.muted }}
      >
        <Menu size={18} />
      </button>

      <div className="topbar-page">
        <div className="page-title" style={{ color: T.text }}>
          {pageTitle}
        </div>
        <Breadcrumbs items={breadcrumbs} />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          flexShrink: 0,
        }}
      >
        <Palette size={14} color={T.muted} aria-hidden="true" />
        <select
          aria-label="Theme preference"
          title="Theme preference"
          value={themePreference}
          onChange={(event) => setThemePreference(event.target.value)}
          style={{
            width: "clamp(78px, 10vw, 104px)",
            height: 30,
            background: T.card,
            border: "1px solid " + T.border,
            borderRadius: 8,
            color: T.text,
            padding: "0 6px",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">System</option>
        </select>
      </div>

      <button
        type="button"
        className="topbar-icon-button"
        aria-label="Notifications"
        style={{ color: T.muted }}
      >
        <Bell size={16} />
      </button>

      <div
        className="topbar-profile"
        style={{
          background: T.card,
          border: "1px solid " + T.border,
        }}
      >
        <Avatar emp={user} size={24} />
        <span style={{ color: T.text }}>{user.name.split(" ")[0]}</span>
      </div>
    </header>
  );
};

export default Topbar;
