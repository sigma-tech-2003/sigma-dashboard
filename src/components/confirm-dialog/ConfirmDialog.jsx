import Btn from "../btn/Btn";
import Modal from "../modal/Modal";

const ConfirmDialog = ({
  title = "Confirm action",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  onClose,
}) => (
  <Modal title={title} onClose={onClose}>
    {message && <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-md)" }}>{message}</div>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)", marginTop: "var(--space-9)" }}>
      <Btn variant="ghost" onClick={onClose}>{cancelLabel}</Btn>
      <Btn variant={variant} onClick={onConfirm}>{confirmLabel}</Btn>
    </div>
  </Modal>
);

export default ConfirmDialog;
