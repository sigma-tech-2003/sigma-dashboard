// src/pages/payroll/MyPayslipsPage.jsx
import { useState } from "react";
import { FileText, Eye } from "lucide-react";

import "./Payroll.css";
import { T } from "../../theme/theme";
import { fmt } from "../../utils/helpers";
import PageHeader from "../../components/page-header/PageHeader";
import EmptyState from "../../components/empty-state/EmptyState";
import Btn from "../../components/btn/Btn";
import PayslipModal from "./PayslipModal";

const normalizedId = (value) => (value == null ? "" : String(value).trim());

const isUsersProcessedPayslip = (payslip, user) =>
  Boolean(normalizedId(payslip?.empId))
  && normalizedId(payslip?.empId) === normalizedId(user?.id)
  && payslip?.status === "processed";

const MyPayslipsPage = ({ payroll, employees, user }) => {
  const [slip, setSlip] = useState(null);

  const mine = payroll.filter((payslip) => isUsersProcessedPayslip(payslip, user));

  return (
    <div>
      <PageHeader title="My payslips" description="View and download your monthly salary slips" />

      {mine.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No payslips yet"
          description="Your payslip appears here once payroll for a month has been processed."
        />
      ) : (
        <div className="payslip-grid">
          {mine.map(p => (
            <div key={p.id} className="payslip-card">
              <div className="payslip-card__head">
                <div className="payslip-card__period">{p.month} {p.year}</div>
                <div className="payslip-card__sub">Salary period</div>
              </div>
              <div className="payslip-card__body">
                {[
                  ["Gross",      fmt(p.basic + p.allowances + p.bonus), T.text],
                  ["Deductions", fmt(p.deductions + p.tax),             T.text],
                  ["Net pay",    fmt(p.net),                            T.text],
                ].map(([k, v, c], index) => (
                  <div key={k} className={"payslip-card__row" + (index === 2 ? " payslip-card__row--net" : "")}>
                    <span>{k}</span>
                    <span style={{ color: c }}>{v}</span>
                  </div>
                ))}
                <Btn
                  variant="ghost"
                  onClick={() => setSlip({
                    ...p,
                    emp: employees.find((employee) =>
                      normalizedId(employee.id) === normalizedId(p.empId)),
                  })}
                >
                  <Eye size={16} aria-hidden="true" />View payslip for {p.month} {p.year}
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {slip && <PayslipModal slip={slip} onClose={() => setSlip(null)} />}
    </div>
  );
};

export default MyPayslipsPage;
