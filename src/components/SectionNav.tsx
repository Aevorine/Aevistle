/**
 * The jump bar for a long settings page.
 *
 * Settings is the one screen that legitimately keeps growing — nine cards and
 * counting — and the honest options are to paginate it or to make it navigable.
 * Pagination hides settings behind a guess about which tab they are on; this
 * keeps everything one scroll away and adds a way to skip the scroll.
 *
 * The highlighted section is decided by an IntersectionObserver rather than by
 * scroll arithmetic: the same "which of these is on screen" question the
 * browser already answers, asked once instead of recomputed on every frame.
 */

import { useEffect, useState } from 'react'

export interface Section {
  id: string
  label: string
}

export function SectionNav({ sections }: { sections: Section[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '')

  useEffect(() => {
    const targets = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null)
    if (targets.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost section that is currently intersecting. Taking the
        // *first* rather than the most-visible keeps the highlight stable
        // while scrolling through a tall card, instead of flickering between
        // two neighbours as their visible areas cross over.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .map((e) => e.target.id)
        if (visible.length === 0) return
        const first = sections.find((s) => visible.includes(s.id))
        if (first) setActive(first.id)
      },
      // The band is the top third of the viewport: a section counts as "the
      // one you are looking at" when its heading is near the top, not when a
      // sliver of it appears at the bottom.
      { rootMargin: '0px 0px -66% 0px', threshold: 0 },
    )
    for (const el of targets) observer.observe(el)
    return () => observer.disconnect()
  }, [sections])

  return (
    <nav className="settingsnav" aria-label="Sections">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className="settingsnav__link"
          aria-current={active === s.id ? 'true' : undefined}
          onClick={() => {
            const el = document.getElementById(s.id)
            // `scroll-margin-top` on the target keeps the heading clear of this
            // sticky bar; without it the anchor lands underneath its own nav.
            el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
        >
          {s.label}
        </button>
      ))}
    </nav>
  )
}
