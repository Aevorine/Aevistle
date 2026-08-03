/**
 * What a screen looks like while its code is still arriving.
 *
 * A spinner would be less work and worse: it says "something is happening"
 * and nothing else, so every screen's wait looks identical and the layout
 * jumps when the real thing lands. These placeholders have the *shape* of what
 * is coming — a page head, then either a form or a list of rows — so the eye
 * has somewhere to settle and nothing moves when the content replaces it.
 *
 * Deliberately not animated with a moving sheen. On a screen that appears for
 * 40 ms, a 1.5-second shimmer only ever shows its first frame; a static block
 * at low contrast reads as "not ready yet" instantly and costs no paint.
 */

export type SkeletonShape = 'form' | 'list'

export function Skeleton({ shape = 'list', rows = 6 }: { shape?: SkeletonShape; rows?: number }) {
  return (
    <div className="view" aria-busy="true" aria-live="polite">
      <div className="view__inner">
        <div className="skeleton__head">
          <div className="skeleton__bar skeleton__bar--title" />
          <div className="skeleton__bar skeleton__bar--sub" />
        </div>

        {shape === 'form' ? (
          <div className="skeleton__card">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton__field">
                <div className="skeleton__bar skeleton__bar--label" />
                <div className="skeleton__bar skeleton__bar--input" />
              </div>
            ))}
          </div>
        ) : (
          <div className="skeleton__card">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="skeleton__row">
                <div className="skeleton__bar skeleton__bar--dot" />
                <div className="skeleton__rowbody">
                  <div className="skeleton__bar skeleton__bar--line" />
                  <div className="skeleton__bar skeleton__bar--line skeleton__bar--short" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
