import { useState } from "react";
import { getNavigationRoutes, getRouteById } from "../../config/routes";
import { T } from "../../theme/theme";
import PageContainer from "./PageContainer";
import "./Layout.css";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

const MOBILE_BREAKPOINT = 768;

const Layout = ({
  user,
  page,
  setPage,
  onLogout,
  children,
  breadcrumbs,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigation = getNavigationRoutes(user);
  const pageTitle = getRouteById(page)?.title || "Dashboard";

  const handleMenuToggle = () => {
    if (window.matchMedia("(max-width: " + (MOBILE_BREAKPOINT - 1) + "px)").matches) {
      setMobileOpen((isOpen) => !isOpen);
      return;
    }

    setCollapsed((isCollapsed) => !isCollapsed);
  };

  const handleNavigate = (pageId) => {
    setPage(pageId);
    setMobileOpen(false);
  };

  return (
    <div
      className="layout"
      style={{ background: T.bg, fontFamily: "var(--font-family)" }}
    >
      <Sidebar
        user={user}
        navigation={navigation}
        page={page}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onNavigate={handleNavigate}
        onClose={() => setMobileOpen(false)}
        onLogout={onLogout}
      />
      <div className="main">
        <Topbar
          user={user}
          pageTitle={pageTitle}
          breadcrumbs={breadcrumbs}
          onMenuToggle={handleMenuToggle}
        />
        <PageContainer>{children}</PageContainer>
      </div>
    </div>
  );
};

export default Layout;
