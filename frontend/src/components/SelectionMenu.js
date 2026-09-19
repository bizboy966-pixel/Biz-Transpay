import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export default function SelectionMenu({
  value,
  onChange,
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
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-xs font-semibold outline-none transition-colors hover:border-blue-300 focus:border-[#2563EB] disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 sm:px-4 sm:py-3 sm:text-sm"
      >
        <span className={`min-w-0 truncate ${selected ? 'text-slate-900' : 'text-slate-400'}`}>
          {selected
            ? (renderValue ? renderValue(selected) : selected.label)
            : placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={placeholder}
          className="absolute left-0 right-0 z-40 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10"
        >
          {options.length === 0 ? (
            <div className="px-3 py-3 text-xs text-slate-400">{emptyMessage}</div>
          ) : (
            options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid={option.testId}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs transition-colors ${
                    isSelected
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    {renderOption ? renderOption(option, isSelected) : option.label}
                  </span>
                  {isSelected && <Check className="h-4 w-4 shrink-0 text-[#2563EB]" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}