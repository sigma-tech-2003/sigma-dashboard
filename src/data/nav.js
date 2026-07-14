// src/data/nav.js
import {
  LayoutDashboard,
  Users,
  Building2,
  Target,
  Calendar,
  DollarSign,
  CreditCard,
} from "lucide-react";

const NAV = [
  { id: "dashboard",   label: "Dashboard",    icon: LayoutDashboard, roles: ["admin", "hr", "employee"] },
  { id: "employees",   label: "Employees",    icon: Users,           roles: ["admin", "hr"]             },
  { id: "departments", label: "Departments",  icon: Building2,       roles: ["admin", "hr"]             }, // ← new
  { id: "kpi",         label: "KPI",          icon: Target,          roles: ["admin", "hr", "employee"] },
  { id: "leave",       label: "Leave",        icon: Calendar,        roles: ["admin", "hr", "employee"] },
  { id: "payroll",     label: "Payroll",      icon: DollarSign,      roles: ["admin", "hr"]             },
  { id: "payslips",    label: "My Payslips",  icon: CreditCard,      roles: ["employee"]                },
];

export default NAV;
