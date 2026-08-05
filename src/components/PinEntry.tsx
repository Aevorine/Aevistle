/**
 * A 6-digit PIN, entered twice for "set" and once for "unlock" — the key
 * `core/pairingFile.ts` derives the file's AES-GCM key from.
 *
 * Same visual weight as any other field in this app: `Field` plus `.input`,
 * not a row of six boxes. It differs from an ordinary numeric field in three
 * small ways — digits only, capped at six, and masked like the account
 * password fields in `AccountDialog.tsx` are, since someone could be reading
 * over a shoulder while a pairing file changes hands.
 */

import { Field, useFieldId } from './ui'

export interface PinEntryProps {
  value: string
  onChange: (value: string) => void
  label: string
  hint?: string
  error?: string
  autoFocus?: boolean
}

export function PinEntry({ value, onChange, label, hint, error, autoFocus }: PinEntryProps) {
  const id = useFieldId('pin')
  return (
    <Field label={label} hint={error ?? hint} htmlFor={id}>
      <input
        id={id}
        className="input mono"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        maxLength={6}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </Field>
  )
}
