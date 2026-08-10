/**
 * Renders a sanitized message body inside a fully inert iframe (no
 * `allow-scripts`) and intercepts link clicks from the *parent* page via
 * `allow-same-origin` — see `electron/sanitizeHtml.ts`'s file header for why
 * this is the shape it is.
 *
 * `find` highlights matches by walking the frame's text nodes from out here.
 * That is only possible because of `allow-same-origin`, and it is the reason
 * the search is done this way rather than by injecting a script: the frame
 * still cannot execute anything, whatever the sanitiser upstream missed.
 *
 * Shared by the inbox reader and the calendar's per-reminder body preview —
 * one render path for HTML that did not originate as this app's own compose
 * text, so a scheduled draft's HTML gets exactly the same protection a
 * received message does rather than a second, unaudited one.
 */

import { useEffect, useRef, useState } from 'react'

/** Wrap a plain-text body so it can go through the same frame the HTML does. */
export function textAsHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<pre style="white-space:pre-wrap;word-break:break-word;font:inherit;margin:0">${escaped}</pre>`
}

export function MessageBodyFrame({
  html,
  find,
  onLinkClick,
  frameClassName = 'reader__frame',
  nightFilter = false,
}: {
  html: string
  find: string
  onLinkClick: (url: string) => void
  /** Defaults to the inbox reader's own sizing; callers with a tighter budget (the calendar's row preview) pass their own. */
  frameClassName?: string
  /**
   * Sender mail is always built on a white `#fff` body (see the injected
   * style below) regardless of the app's own theme — reasonable in light
   * mode, a lit rectangle in the middle of a dark one. This inverts the
   * whole frame and un-inverts images/video so photos still look right; it
   * cannot know which senders picked colours on purpose, which is why the
   * caller offers a way back to the original per message rather than this
   * component deciding for good.
   */
  nightFilter?: boolean
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(0)

  /**
   * The click handler is installed on the frame's *document*, once, when the
   * frame loads — and it is never removed, because the document goes away with
   * the frame. So the effect below must not depend on `onLinkClick`: it would
   * re-register the `load` listener on an iframe that has already loaded,
   * `handleLoad` would not run again, and the document would keep the handler
   * built on the first render's closure. `openLinkSafely` closes over `t`,
   * which is rebuilt every render, so switching language with a preview open
   * left the open-link confirmation in the previous one.
   */
  const linkRef = useRef(onLinkClick)
  linkRef.current = onLinkClick

  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return
    const handleLoad = () => {
      setLoaded((n) => n + 1)
      const doc = iframe.contentDocument
      if (!doc) return
      const handler = (e: MouseEvent) => {
        const target = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null
        if (!target) return
        e.preventDefault()
        linkRef.current(target.href)
      }
      doc.addEventListener('click', handler)
      // Match the app's own type so a plain-text mail does not arrive in
      // whatever the engine's default serif happens to be.
      //
      // The `margin-inline: auto` run is the fix for the oldest-looking
      // complaint about this app: "only the left half of the window has
      // anything in it". Bulk mail is built as a fixed `<table width="600">`,
      // and a 600px table left-aligned in a reader that is 1474px wide on a
      // 1536px screen paints 52% of the window and leaves the other 48% blank
      // — all of it on the right, because the table hugs the start edge.
      // Centring moves half that emptiness to the other side, which is the
      // difference between a page that looks broken and a page that looks
      // like every other mail client.
      //
      // Only the outermost box is touched, and only through `margin-inline`,
      // which is inert on anything already as wide as its parent: fluid mail
      // and plain text are bit-identical before and after. Sender HTML is not
      // otherwise restyled — there is no safe general rule for it — and
      // `margin-inline` rather than `margin-left/right` so an Arabic message
      // in an RTL window centres the same way (measured: before this, an RTL
      // 600px table pinned to the right and left the blank on the *left*).
      //
      // Two conditions, both load-bearing. `:not(table table)` picks the
      // outer frame at whatever depth the sender buried it — a nested table
      // is positioned by the design around it and must not move. And a
      // declared width is what separates "this is a fixed-width layout" from
      // "this is a small data table in a text mail": the second one belongs
      // where the sender put it, and centring it would be this rule inventing
      // a design decision rather than repairing one. `width="100%"` matches
      // too and is harmless — there is no free margin to distribute.
      const centreOuter =
        'table[width]:not(table table),' +
        'table[style*="width"]:not(table table),' +
        'body>:is(div,center,section,article)[style*="width"]' +
        '{margin-inline:auto}'
      const style = doc.createElement('style')
      style.textContent =
        'body{margin:0;padding:16px;font-family:inherit;color:#111;background:#fff;word-break:break-word}' +
        'img{max-width:100%;height:auto}table{max-width:100%}' +
        centreOuter +
        'mark.aev-find{background:#ffe066;color:#111}'
      doc.head?.appendChild(style)
    }
    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [])

  /**
   * A second, dedicated `<style>` rather than folding this into the one
   * above: that one is written once, in `handleLoad`, and never again for
   * the life of this document — right for the fixed base rules, wrong for a
   * filter the reader toggles on and off without the frame reloading.
   */
  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.head) return
    let style = doc.getElementById('aev-night') as HTMLStyleElement | null
    if (!nightFilter) {
      style?.remove()
      return
    }
    if (!style) {
      style = doc.createElement('style')
      style.id = 'aev-night'
      doc.head.appendChild(style)
    }
    // Invert the frame, then invert media back — the standard trick for
    // adapting content nobody authored for a dark background. It changes
    // colours the sender chose on purpose too, which is exactly what the
    // "view original colors" toggle this is paired with exists to undo.
    style.textContent =
      'html{filter:invert(1) hue-rotate(180deg)}' +
      'img,video,svg,canvas{filter:invert(1) hue-rotate(180deg)}'
  }, [nightFilter, loaded])

  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.body) return

    // Clear previous highlights first, or a second search would highlight
    // inside the marks the first one left behind.
    for (const mark of [...doc.querySelectorAll('mark.aev-find')]) {
      const parent = mark.parentNode
      if (!parent) continue
      parent.replaceChild(doc.createTextNode(mark.textContent ?? ''), mark)
      parent.normalize()
    }
    const needle = find.trim().toLowerCase()
    if (needle.length === 0) return

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? '').toLowerCase().includes(needle)) targets.push(node as Text)
    }

    let first: HTMLElement | null = null
    for (const text of targets) {
      const value = text.textContent ?? ''
      const fragment = doc.createDocumentFragment()
      let index = 0
      for (;;) {
        const at = value.toLowerCase().indexOf(needle, index)
        if (at < 0) break
        fragment.appendChild(doc.createTextNode(value.slice(index, at)))
        const mark = doc.createElement('mark')
        mark.className = 'aev-find'
        mark.textContent = value.slice(at, at + needle.length)
        fragment.appendChild(mark)
        first ??= mark
        index = at + needle.length
      }
      fragment.appendChild(doc.createTextNode(value.slice(index)))
      text.parentNode?.replaceChild(fragment, text)
    }
    first?.scrollIntoView({ block: 'center' })
  }, [find, loaded, html])

  return (
    <iframe
      ref={ref}
      // No `allow-scripts` — the content cannot execute anything regardless
      // of whether the sanitizer upstream has a bug. `allow-same-origin`
      // alone is what lets the effects above reach `contentDocument`.
      sandbox="allow-same-origin"
      srcDoc={html}
      title="message-body"
      className={frameClassName}
    />
  )
}
