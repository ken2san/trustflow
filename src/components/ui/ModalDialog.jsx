import { useEffect, useRef } from "react";

/**
 * Generic modal dialog component for confirmations, forms, etc.
 * Props:
 * - open: boolean (show/hide)
 * - onClose: function (close handler)
 * - title: string (modal title)
 * - children: content (JSX)
 * - actions: JSX (footer actions/buttons)
 */
export default function ModalDialog({ open, onClose, title, children, actions }) {
  const dialogRef = useRef(null);
  // Focus trap and ESC to close
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog) dialog.focus();
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
      // Trap focus inside modal
      if (e.key === 'Tab') {
        const focusable = dialog.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in" aria-modal="true" role="dialog">
      <div
        ref={dialogRef}
        className="bg-slate-900/90 p-8 sm:p-10 rounded-3xl shadow-2xl border border-indigo-500/30 w-full max-w-lg space-y-8 relative outline-none backdrop-blur-xl animate-modal-pop"
        tabIndex={-1}
        aria-labelledby="modal-title"
      >
        {/* Close button removed for cleaner modal; rely on Cancel action below */}
        {title && <h3 id="modal-title" className="text-2xl font-extrabold text-white mb-4 tracking-tight drop-shadow-lg">{title}</h3>}
        <div className="text-indigo-100 text-lg font-medium space-y-4">{children}</div>
        {actions && <div className="flex gap-4 justify-end mt-6">{actions}</div>}
      </div>
      {/* Add keyframes for modal-pop animation */}
      <style>{`
        @keyframes modal-pop {
          0% { transform: scale(0.95) translateY(40px); opacity: 0; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        .animate-modal-pop { animation: modal-pop 0.35s cubic-bezier(0.4,0,0.2,1); }
        .animate-fade-in { animation: fade-in 0.4s ease; }
        @keyframes fade-in {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
