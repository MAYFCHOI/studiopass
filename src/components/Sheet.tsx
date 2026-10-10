import type { ReactNode } from 'react';
export function Sheet({ onClose, children, title }: { onClose: () => void; children: ReactNode; title?: string }) {
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}
