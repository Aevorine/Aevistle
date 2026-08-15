/**
 * The `AppState` reducer's contacts domain: adding/editing (`upsertContact`)
 * and deleting (`removeContact`) an entry in `state.contacts`.
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in.
 */

import type { AppState, Contact } from '../../core/types'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type ContactAction = { type: 'upsertContact'; contact: Contact } | { type: 'removeContact'; id: string }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the two case labels above, grouped onto one shared case
 * body — the switch here still has one branch per action, unchanged from
 * what lived inline in `AppState.tsx` before the move.
 */
export function applyContactAction(state: AppState, action: ContactAction): AppState {
  switch (action.type) {
    case 'upsertContact': {
      const exists = state.contacts.some((c) => c.id === action.contact.id)
      // Stamped here rather than at every call site — pinned/imported/edited
      // contacts all go through this one action, and `updatedAt` exists for
      // `core/syncConflict.ts` to tell "changed since the last sync" apart
      // from "always looked like this".
      const contact = { ...action.contact, updatedAt: Date.now() }
      return {
        ...state,
        contacts: exists
          ? state.contacts.map((c) => (c.id === contact.id ? contact : c))
          : [...state.contacts, contact],
      }
    }

    case 'removeContact':
      return { ...state, contacts: state.contacts.filter((c) => c.id !== action.id) }
  }
}
