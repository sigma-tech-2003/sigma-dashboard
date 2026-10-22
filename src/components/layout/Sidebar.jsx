import { useRef } from "react";
import { Briefcase, LogOut } from "lucide-react";
import { useSlidingIndicator } from "../../hooks/motion/useSlidingIndicator";
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
}) => {
  const navRef = useRef(null);
  useSlidingIndicator(navRef, page, "y");

  return (
  <>
    <aside
      className={[
        "sidebar",
        collapsed && "sidebar--collapsed",
        mobileOpen && "sidebar--mobile-open",
      ].filter(Boolean).join(" ")}
    >
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="logo-box">
            <Briefcase size={16} aria-hidden="true" />
          </div>
          {!collapsed && (
            <div className="sidebar-brand">
              Sigma HRM <span className="sidebar-brand__sub">Portal</span>
            </div>
          )}
        </div>
      </div>

      <nav ref={navRef} className="nav" aria-label="Main navigation">
        <span className="nav-indicator" data-indicator aria-hidden="true" />
        {navigation.map((item) => {
          const active = page === item.id;
          const Icon = item.icon;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={"nav-btn" + (active ? " nav-btn--active" : "")}
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : undefined}
              aria-label={collapsed ? item.label : undefined}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {!collapsed && item.label}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="user-box">
          <Avatar emp={user} size={32} />
          {!collapsed && (
            <div className="user-box__details">
              <div className="user-box__name">{user.name}</div>
              <Badge s={user.role} />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="nav-btn"
          aria-label={collapsed ? "Sign out" : undefined}
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut size={16} aria-hidden="true" />
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
};

export default Sidebar;
