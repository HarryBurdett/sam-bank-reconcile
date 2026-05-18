/**
 * Searchable bank-account dropdown.
 *
 * One widget used by every page that needs the operator to pick a
 * bank — bank-transfer modal (Imports), bank-transfer in Reconcile,
 * future flows. Single implementation means a UX change or bug fix
 * lands everywhere at once instead of being re-derived per page.
 *
 * Features:
 *   - Searchable input — filter by code / description / sort code /
 *     account number.
 *   - Auto-resolve typed code — typing "BB010" (exact match) sets
 *     the value immediately, no dropdown click required.
 *   - Keyboard navigation — ↑/↓ to move, Enter/Tab to select,
 *     Escape to close.
 *   - Excludes a configurable list of codes (used to hide the
 *     current bank from the source/destination picker).
 *   - Empty-list state — shows "No matching bank accounts found"
 *     so the operator can tell the difference between "no match"
 *     and "list still loading".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBankAccounts, type BankAccount } from '../hooks/useBankAccounts';

export interface BankAccountPickerProps {
  /** Currently-selected bank code, or empty string when nothing
   *  selected yet. */
  value: string;
  /** Called with the new code when the operator picks one. Called
   *  with empty string when the operator clears the input. */
  onChange: (code: string) => void;
  /** Bank codes to hide from the dropdown — typically the current
   *  bank, so operators can't transfer to themselves. */
  excludeCodes?: string[];
  /** Visible label rendered above the input. */
  label?: string;
  /** Show a red asterisk after the label. */
  required?: boolean;
  /** Placeholder text shown when the input is empty. */
  placeholder?: string;
  /** Optional callback fired when the operator presses Enter on a
   *  selected option (lets the parent focus the next field). */
  onEnterSelect?: () => void;
  /** Stable input id (for label htmlFor). */
  inputId?: string;
}

export function BankAccountPicker(props: BankAccountPickerProps): JSX.Element {
  const {
    value,
    onChange,
    excludeCodes = [],
    label,
    required,
    placeholder = 'Search by code, name or sort code...',
    onEnterSelect,
    inputId,
  } = props;

  const { accounts } = useBankAccounts();
  const [search, setSearch] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // When `value` is set externally (e.g. parent has pre-selected a
  // bank from saved state), populate the search field with the
  // "code - description" display string so the user sees the chosen
  // bank instead of an empty field.
  const valueDescription = useMemo(() => {
    if (!value) return null;
    return accounts.find((b) => b.code === value) ?? null;
  }, [value, accounts]);
  useEffect(() => {
    if (valueDescription) {
      const display = `${valueDescription.code} - ${valueDescription.description}`;
      setSearch((cur) => (cur === '' ? display : cur));
    }
  }, [valueDescription]);

  const visible = useMemo<BankAccount[]>(() => {
    const exclude = new Set(excludeCodes);
    return accounts.filter((b) => {
      if (exclude.has(b.code)) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        b.code.toLowerCase().includes(q) ||
        b.description.toLowerCase().includes(q) ||
        (b.sort_code && b.sort_code.includes(search)) ||
        (b.account_number && b.account_number.includes(search))
      );
    });
  }, [accounts, excludeCodes, search]);

  // Auto-resolve when typed text exactly matches a bank code. Done
  // at render-time via useMemo so it's robust against the state
  // propagation timing issues that bit us with earlier point-fixes.
  const typedExactMatch = useMemo<BankAccount | null>(() => {
    if (!search) return null;
    const trimmed = search.trim().toUpperCase();
    if (!trimmed) return null;
    const exclude = new Set(excludeCodes);
    return (
      accounts.find(
        (b) => b.code.toUpperCase() === trimmed && !exclude.has(b.code),
      ) ?? null
    );
  }, [search, accounts, excludeCodes]);
  useEffect(() => {
    if (typedExactMatch && typedExactMatch.code !== value) {
      onChange(typedExactMatch.code);
    }
  }, [typedExactMatch, value, onChange]);

  const commitSelection = (b: BankAccount): void => {
    onChange(b.code);
    setSearch(`${b.code} - ${b.description}`);
    setDropdownOpen(false);
  };

  return (
    <div className="relative">
      {label && (
        <label
          className="block text-sm font-medium text-gray-700 mb-1"
          htmlFor={inputId}
        >
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        value={search}
        onChange={(e) => {
          const v = e.target.value;
          setSearch(v);
          setDropdownOpen(true);
          setHighlightIdx(0);
          // If the operator edits to something that no longer
          // matches the selected code, clear the selection. The
          // typed-exact-match effect above will re-set it when a
          // valid match appears again.
          if (value) {
            const stillMatches =
              v.trim().toUpperCase() === value.toUpperCase() ||
              v.startsWith(value + ' ');
            if (!stillMatches) onChange('');
          }
        }}
        onFocus={() => {
          setDropdownOpen(true);
          setHighlightIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!dropdownOpen) setDropdownOpen(true);
            else setHighlightIdx((i) => Math.min(i + 1, visible.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && dropdownOpen && visible.length > 0) {
            e.preventDefault();
            const picked = visible[highlightIdx];
            if (picked) {
              commitSelection(picked);
              onEnterSelect?.();
            }
          } else if (e.key === 'Escape') {
            setDropdownOpen(false);
          } else if (e.key === 'Tab' && dropdownOpen && visible.length > 0) {
            const picked = visible[highlightIdx];
            if (picked) {
              onChange(picked.code);
              setSearch(`${picked.code} - ${picked.description}`);
            }
            setDropdownOpen(false);
          } else if (e.key === 'Tab') {
            setDropdownOpen(false);
          }
        }}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
      {dropdownOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setDropdownOpen(false)}
          />
          <div className="absolute z-[60] w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
            {visible.map((b, idx) => (
              <button
                key={b.code}
                type="button"
                onClick={() => commitSelection(b)}
                className={`w-full text-left px-3 py-2 text-sm ${
                  idx === highlightIdx ? 'bg-blue-100' : 'hover:bg-blue-50'
                } ${value === b.code ? 'text-blue-800' : ''}`}
              >
                <div>
                  <span className="font-medium">{b.code}</span>
                  <span className="text-gray-600"> - {b.description}</span>
                </div>
                {b.sort_code && (
                  <div className="text-xs text-gray-500">
                    Sort: {b.sort_code}
                    {b.account_number && ` | Acc: ${b.account_number}`}
                  </div>
                )}
              </button>
            ))}
            {visible.length === 0 && (
              <div className="px-3 py-2 text-sm text-gray-500">
                {accounts.length === 0
                  ? 'Loading bank accounts...'
                  : 'No matching bank accounts found'}
              </div>
            )}
          </div>
        </>
      )}
      {valueDescription && (
        <div className="mt-2 text-xs text-gray-500">
          {valueDescription.sort_code && (
            <span>Sort: {valueDescription.sort_code} </span>
          )}
          {valueDescription.account_number && (
            <span>Acc: {valueDescription.account_number}</span>
          )}
        </div>
      )}
    </div>
  );
}
