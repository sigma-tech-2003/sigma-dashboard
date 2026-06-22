import { Home, Users, Target, Calendar, CreditCard, FileText } from "lucide-react";

const NAV = [
  { id: "dashboard",  label: "Dashboard",   icon: Home,       roles: ["admin", "hr", "employee"] },
  { id: "employees",  label: "Employees",   icon: Users,      roles: ["admin", "hr"] },
  { id: "kpi",        label: "KPI Tracker", icon: Target,     roles: ["admin", "hr", "employee"] },
  { id: "leave",      label: "Leave",       icon: Calendar,   roles: ["admin", "hr", "employee"] },
  { id: "payroll",    label: "Payroll",     icon: CreditCard, roles: ["admin", "hr"] },
  { id: "payslips",   label: "My Payslip",  icon: FileText,   roles: ["employee"] },
];

export default NAV;