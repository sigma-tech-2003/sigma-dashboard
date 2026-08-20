import {
  Building2,
  Calendar,
  CreditCard,
  DollarSign,
  FolderKanban,
  LayoutDashboard,
  Target,
  Users,
} from "lucide-react";
import { ROLES } from "../utils/permissions";

const ALL_ROLES = Object.values(ROLES);

export const APP_ROUTES = [
  {
    id: "dashboard",
    path: "/dashboard",
    label: "Dashboard",
    title: "Dashboard",
    icon: LayoutDashboard,
    group: "Overview",
    roles: ALL_ROLES,
    navigationRoles: [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.TL, ROLES.EMPLOYEE],
    breadcrumbs: [{ label: "Dashboard" }],
    load: () => import("../pages/dashboard/Dashboard"),
  },
  {
    id: "employees",
    path: "/employees",
    label: "Employees",
    title: "Employees",
    icon: Users,
    group: "People",
    roles: [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.TL],
    navigationRoles: [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.TL],
    breadcrumbs: [{ label: "People" }, { label: "Employees" }],
    load: () => import("../pages/employees/EmployeesPage"),
  },
  {
    id: "departments",
    path: "/departments",
    label: "Departments",
    title: "Departments",
    icon: Building2,
    group: "People",
    roles: [ROLES.ADMIN, ROLES.HR],
    navigationRoles: [ROLES.ADMIN, ROLES.HR],
    breadcrumbs: [{ label: "People" }, { label: "Departments" }],
    load: () => import("../pages/departments/DepartmentsPage"),
  },
  {
    id: "projects",
    path: "/projects",
    label: "Projects",
    title: "Projects",
    icon: FolderKanban,
    group: "Workforce",
    roles: ALL_ROLES,
    navigationRoles: ALL_ROLES,
    breadcrumbs: [{ label: "Workforce" }, { label: "Projects" }],
    load: () => import("../pages/projects/ProjectsPage"),
  },
  {
    id: "kpi",
    path: "/kpi",
    label: "KPI",
    title: "KPI",
    icon: Target,
    group: "Workforce",
    roles: ALL_ROLES,
    navigationRoles: [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.TL, ROLES.EMPLOYEE],
    breadcrumbs: [{ label: "Workforce" }, { label: "KPI" }],
    load: () => import("../pages/kpi/KPIPage"),
  },
  {
    id: "leave",
    path: "/leave",
    label: "Leave",
    title: "Leave",
    icon: Calendar,
    group: "Workforce",
    roles: ALL_ROLES,
    navigationRoles: [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.TL, ROLES.EMPLOYEE],
    breadcrumbs: [{ label: "Workforce" }, { label: "Leave" }],
    load: () => import("../pages/leave/LeavePage"),
  },
  {
    id: "payroll",
    path: "/payroll",
    label: "Payroll",
    title: "Payroll",
    icon: DollarSign,
    group: "Finance",
    roles: [ROLES.ADMIN, ROLES.HR],
    navigationRoles: [ROLES.ADMIN, ROLES.HR],
    breadcrumbs: [{ label: "Finance" }, { label: "Payroll" }],
    load: () => import("../pages/payroll/PayrollPage"),
  },
  {
    id: "payslips",
    path: "/payslips",
    label: "My Payslips",
    title: "My Payslips",
    icon: CreditCard,
    group: "Finance",
    roles: [ROLES.EMPLOYEE],
    navigationRoles: [ROLES.EMPLOYEE],
    breadcrumbs: [{ label: "Finance" }, { label: "My Payslips" }],
    load: () => import("../pages/payroll/MyPayslipsPage"),
  },
];

export const DEFAULT_ROUTE_ID = "dashboard";

export const getRouteById = (routeId) =>
  APP_ROUTES.find((route) => route.id === routeId);

export const getRouteByPath = (path) =>
  APP_ROUTES.find((route) => route.path === path);

export const canAccessRoute = (user, route) =>
  Boolean(user && route?.roles.includes(user.role));

export const getDefaultRoute = (user) =>
  APP_ROUTES.find((route) => route.id === DEFAULT_ROUTE_ID && canAccessRoute(user, route))
  || APP_ROUTES.find((route) => canAccessRoute(user, route));

export const getNavigationRoutes = (user) =>
  APP_ROUTES.filter((route) =>
    canAccessRoute(user, route) && route.navigationRoles.includes(user.role),
  );

export const getNavigationGroups = (user) =>
  getNavigationRoutes(user).reduce((groups, route) => {
    const routes = groups.get(route.group) || [];
    groups.set(route.group, [...routes, route]);
    return groups;
  }, new Map());
