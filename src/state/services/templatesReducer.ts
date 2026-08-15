/**
 * The `AppState` reducer's templates domain: adding/editing (`upsertTemplate`)
 * and deleting (`removeTemplate`) an entry in `state.templates`.
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in.
 */

import type { AppState, Template } from '../../core/types'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type TemplateAction = { type: 'upsertTemplate'; template: Template } | { type: 'removeTemplate'; id: string }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the two case labels above, grouped onto one shared case
 * body — the switch here still has one branch per action, unchanged from
 * what lived inline in `AppState.tsx` before the move.
 */
export function applyTemplateAction(state: AppState, action: TemplateAction): AppState {
  switch (action.type) {
    case 'upsertTemplate': {
      const exists = state.templates.some((t) => t.id === action.template.id)
      return {
        ...state,
        templates: exists
          ? state.templates.map((t) => (t.id === action.template.id ? action.template : t))
          : [...state.templates, action.template],
      }
    }

    case 'removeTemplate':
      return { ...state, templates: state.templates.filter((t) => t.id !== action.id) }
  }
}
