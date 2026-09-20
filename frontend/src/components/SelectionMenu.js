import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';

export default function SelectionMenu({
  value,
  onChange,
  label,
  options = [],
  placeholder = 'Sélectionner',
  disabled = false,
  testId,
  renderOption,
  renderValue,
  emptyMessage = 'Aucune option disponible',
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);
  const closeRef = useRef(null);
  const optionRefs = useRef([]);
  const dialogId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = options.find((option) => option.value === value);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = () => {
    if (disabled) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'Tab') {
        const focusable = [
          closeRef.current,
          ...optionRefs.current.filter(Boolean),
        ].filter(Boolean);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!dialogRef.current?.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = requestAnimationFrame(() => {
      (optionRefs.current[selectedIndex] || closeRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, selectedIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        ref={triggerRef}
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-label={label || placeholder}
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => (open ? close() : openMenu())}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-xs font-semibold outline-none transition-colors hover:border-blue-300 focus:border-[#2563EB] disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 sm:px-4 sm:py-3 sm:text-sm"
      >
        <span className={`min-w-0 truncate ${selected ? 'text-slate-900' : 'text-slate-400'}`}>
          {selected
            ? (renderValue ? renderValue(selected) : selected.label)
            : placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[2px] sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            id={dialogId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${dialogId}-title`}
            className="flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-950/20"
          >
            <div className="flex shrink-0 items-start justify-between border-b border-slate-100 px-5 py-4 sm:px-6">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#2563EB]">Biz-transPay</p>
                <h2 id={`${dialogId}-title`} className="mt-1 font-cabinet text-lg font-extrabold tracking-tight text-slate-900">
                  {label || placeholder}
                </h2>
                <p className="mt-1 text-xs text-slate-500">Choisissez une option pour continuer.</p>
              </div>
              <button
                type="button"
                ref={closeRef}
                aria-label="Fermer la fenêtre"
                onClick={close}
                className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div
              role="listbox"
              aria-label={label || placeholder}
              aria-activedescendant={options[activeIndex] ? `${dialogId}-option-${activeIndex}` : undefined}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (!options.length) return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const direction = event.key === 'ArrowDown' ? 1 : -1;
                  const next = (activeIndex + direction + options.length) % options.length;
                  setActiveIndex(next);
                  optionRefs.current[next]?.focus();
                }
                if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault();
                  const next = event.key === 'Home' ? 0 : options.length - 1;
                  setActiveIndex(next);
                  optionRefs.current[next]?.focus();
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  const option = options[activeIndex];
                  if (option) {
                    onChange(option.value);
                    close();
                  }
                }
              }}
              className="min-h-0 flex-1 overflow-y-auto p-3 overscroll-contain sm:p-4"
            >
              {options.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-xs text-slate-400">{emptyMessage}</div>
              ) : (
                <div className="space-y-1.5">
                  {options.map((option, index) => {
                    const isSelected = option.value === value;
                    return (
                      <button
                        key={option.value}
                        id={`${dialogId}-option-${index}`}
                        ref={(element) => { optionRefs.current[index] = element; }}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        data-testid={option.testId}
                        tabIndex={index === activeIndex ? 0 : -1}
                        onFocus={() => setActiveIndex(index)}
                        onClick={() => {
                          onChange(option.value);
                          close();
                        }}
                        className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left text-sm transition-colors ${
                          isSelected
                            ? 'border-blue-200 bg-blue-50/80 text-blue-700'
                            : 'border-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <span className="min-w-0 flex-1">{renderOption ? renderOption(option, isSelected) : option.label}</span>
                        {isSelected && <Check className="h-4 w-4 shrink-0 text-[#2563EB]" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}