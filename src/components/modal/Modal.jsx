import "./Modal.css";
import { T } from "../../theme/theme";
import { X } from "lucide-react";

const Modal = ({ title, onClose, children, wide }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div
      className="modal-box"
      style={{
        background: T.surface,
        border: `1px solid ${T.border}`,
        maxWidth: wide ? 720 : 480,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="modal-header"
        style={{ borderBottom: `1px solid ${T.border}` }}
      >
        <span
          className="modal-title"
          style={{ color: T.text }}
        >
          {title}
        </span>

        <button
          className="modal-close"
          onClick={onClose}
          style={{ color: T.muted }}
        >
          <X size={18} />
        </button>
      </div>

      <div className="modal-body">{children}</div>
    </div>
  </div>
);

export default Modal;