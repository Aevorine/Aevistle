/**
 * The one thing standing between a thrown render and a white window.
 *
 * React unmounts the entire tree when a component throws during render and
 * nothing above it catches. In an app whose whole job is to be sitting there
 * when a reminder is due, that is the worst possible failure mode: the window
 * goes blank, the scheduled sends are still on disk and still armed, and there
 * is nothing on screen to say so — or even to say that anything went wrong.
 *
 * This was reached in practice from a single malformed record. One contact
 * with a missing field threw inside `buildPool`, `TagField` came down, and it
 * took every other screen in the application with it. React logged its usual
 * "consider adding an error boundary" warning to a console no user has open.
 *
 * Two levels are used, deliberately:
 *
 *   - Around each view, so a screen that cannot render costs the user that
 *     screen and nothing else. The sidebar stays, the other eight tabs still
 *     work, and the reminder that was due in ten minutes is still armed.
 *   - Around the shell, as the backstop for a throw in the frame itself.
 *
 * `reset` exists because most of these are data-shaped rather than permanent:
 * the view that failed on one bad row will often render once the user has
 * deleted it somewhere else, and forcing a restart of the whole application to
 * find that out is a worse experience than a button.
 */
import React from 'react'

type Props = {
  children: React.ReactNode
  /** Names the area that failed, so the message can say which screen it was. */
  label?: string
  /** Rendered instead of the default panel when the subtree is decorative. */
  fallback?: React.ReactNode
}

type State = { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Goes to the console rather than to the log store on purpose: writing to
    // application state from an error path risks a second throw inside the
    // handler for the first, and the component stack is the part that actually
    // identifies the fault.
    console.error(`[ui] ${this.props.label ?? 'component'} failed to render:`, error, info.componentStack)
  }

  /**
   * Remount the subtree. Keyed off a counter rather than clearing `error`
   * alone, because a child that failed in a `useMemo` would otherwise be
   * handed back its identical memoised inputs and throw again immediately.
   */
  private reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <div className="uifail" role="alert">
        <h2 className="uifail__title">This screen could not be displayed</h2>
        <p className="uifail__detail">{this.state.error.message}</p>
        <p className="uifail__hint">
          Your accounts, scheduled sends and mail are unaffected — they are stored on disk and
          nothing here has changed them. Other screens still work.
        </p>
        <button className="btn btn--secondary uifail__retry" type="button" onClick={this.reset}>
          Try again
        </button>
      </div>
    )
  }
}
