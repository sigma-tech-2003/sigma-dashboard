import { Briefcase, ChevronRight, LogOut } from "lucide-react";
import { T } from "../../theme/theme";
import Avatar from "../avatar/Avatar";
import Badge from "../badge/Badge";

const Sidebar = ({
  user,
  navigation,
  page,
  collapsed,
  mobileOpen,
  onNavigate,
  onClose,
  onLogout,
}) => (
  <>
    <aside
      className={[
        "sidebar",
        collapsed && "sidebar--collapsed",
        mobileOpen && "sidebar--mobile-open",
      ].filter(Boolean).join(" ")}
      style={{
        background: T.sidebar,
        borderRight: "1px solid " + T.sidebarBorder,
      }}
    >
      <div
        className="sidebar-header"
        style={{ borderBottom: "1px solid " + T.sidebarBorder }}
      >
        <div className="sidebar-logo">
          <div
            className="logo-box"
            style={{
              background: "linear-gradient(135deg, " + T.primary + ", " + T.purple + ")",
            }}
          >
            <Briefcase size={16} color={T.white} />
          </div>
          {!collapsed && (
            <div className="sidebar-brand" style={{ color: T.text }}>
              SIGMA HRM <span style={{ color: T.primary }}>Portal</span>
            </div>
          )}
        </div>
      </div>

      <nav className="nav" aria-label="Main navigation">
        {navigation.map((item) => {
          const active = page === item.id;
          const Icon = item.icon;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className="nav-btn"
              style={{
                background: active ? T.primaryTint : "transparent",
                color: active ? T.primary : T.muted,
                fontWeight: active ? 700 : 500,
              }}
            >
              <Icon size={16} />
              {!collapsed && item.label}
              {active && !collapsed && (
                <ChevronRight size={12} className="nav-btn__indicator" />
              )}
            </button>
          );
        })}
      </nav>

      <div
        className="sidebar-footer"
        style={{ borderTop: "1px solid " + T.sidebarBorder }}
      >
        <div className="user-box">
          <Avatar emp={user} size={32} />
          {!collapsed && (
            <div className="user-box__details">
              <div className="user-box__name" style={{ color: T.text }}>
                {user.name}
              </div>
              <Badge s={user.role} />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="nav-btn"
          style={{ color: T.muted, fontFamily: "inherit" }}
        >
          <LogOut size={16} />
          {!collapsed && "Sign out"}
        </button>
      </div>
    </aside>
    {mobileOpen && (
      <div
        className="sidebar-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
    )}
  </>
);

export default Sidebar;
