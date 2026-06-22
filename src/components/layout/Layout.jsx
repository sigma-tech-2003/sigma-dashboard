import "./Layout.css";
import { useState } from "react";
import { T } from "../../theme/theme";
import  NAV  from "../../data/nav";
import {
  Briefcase, ChevronRight, LogOut, Menu, Bell
} from "lucide-react";
import Avatar from "../components/avatar/Avatar";
import Badge from "../components/badge/Badge";

const Layout = ({ user, page, setPage, onLogout, children }) => {
  const [collapsed, setCollapsed] = useState(false);
  const nav = NAV.filter(n => n.roles.includes(user.role));

  return (
    <div className="layout" style={{ background: T.bg, fontFamily: "'Outfit',sans-serif" }}>

      {/* Sidebar */}
      <div
        className="sidebar"
        style={{
          width: collapsed ? 60 : 220,
          background: T.sidebar,
          borderRight: `1px solid ${T.sidebarBorder}`
        }}
      >
        <div className="sidebar-header" style={{ borderBottom: `1px solid ${T.sidebarBorder}` }}>
          <div className="sidebar-logo">
            <div
              className="logo-box"
              style={{ background: `linear-gradient(135deg,${T.primary},${T.purple})` }}
            >
              <Briefcase size={16} color="#fff" />
            </div>

            {!collapsed && (
              <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>
                SIGMA HRM <span style={{ color: T.primary }}>Portal</span>
              </div>
            )}
          </div>
        </div>

        <nav className="nav">
          {nav.map(n => {
            const active = page === n.id;

            return (
              <button
                key={n.id}
                onClick={() => setPage(n.id)}
                className="nav-btn"
                style={{
                  background: active ? `${T.primary}20` : "transparent",
                  color: active ? T.primary : T.muted,
                  fontWeight: active ? 700 : 500
                }}
              >
                <n.icon size={16} />
                {!collapsed && n.label}

                {active && !collapsed && (
                  <ChevronRight size={12} style={{ marginLeft: "auto" }} />
                )}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer" style={{ borderTop: `1px solid ${T.sidebarBorder}` }}>
          <div className="user-box">
            <Avatar emp={user} size={32} />

            {!collapsed && (
              <div style={{ overflow: "hidden" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
                  {user.name}
                </div>
                <Badge s={user.role} />
              </div>
            )}
          </div>

          <button
            onClick={onLogout}
            className="nav-btn"
            style={{ color: T.muted, fontFamily: "inherit" }}
          >
            <LogOut size={16} />
            {!collapsed && "Sign out"}
          </button>
        </div>
      </div>

      {/* Main */}
      <div className="main">
        <div
          className="topbar"
          style={{
            background: T.surface,
            borderBottom: `1px solid ${T.border}`
          }}
        >
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{ background: "none", border: "none", color: T.muted }}
          >
            <Menu size={18} />
          </button>

          <div className="page-title" style={{ color: T.text }}>
            {nav.find(n => n.id === page)?.label || "Dashboard"}
          </div>

          <Bell size={16} color={T.muted} />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 10px",
              background: T.card,
              borderRadius: 8,
              border: `1px solid ${T.border}`
            }}
          >
            <Avatar emp={user} size={24} />
            <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>
              {user.name.split(" ")[0]}
            </span>
          </div>
        </div>

        <div className="content">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Layout;
