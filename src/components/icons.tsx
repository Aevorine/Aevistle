/**
 * Hand-rolled icon set.
 *
 * Deliberately not an icon library: the app needs about two dozen glyphs, and
 * a dependency for that would add install weight, a supply-chain surface and a
 * tree-shaking problem for a build that already has to run on Android.
 * Every path below is a 24×24 stroke icon on the same grid.
 */

import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8Z" />
  </Svg>
)

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 1.9" />
  </Svg>
)

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2.5" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
)

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15.5 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20" />
    <circle cx="9.2" cy="8" r="3.4" />
    <path d="M21 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M16.2 4.7a3.4 3.4 0 0 1 0 6.6" />
  </Svg>
)

export const IconFileText = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Svg>
)

export const IconActivity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Svg>
)

export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11.5 12.6 20a5 5 0 0 1-7.1-7.1l8.5-8.4a3.3 3.3 0 1 1 4.7 4.7l-8.5 8.4a1.7 1.7 0 0 1-2.3-2.3l7.8-7.8" />
  </Svg>
)

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m20 6-11 11-5-5" />
  </Svg>
)

export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
  </Svg>
)

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17.2h.01" />
  </Svg>
)

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4.5M12 8h.01" />
  </Svg>
)

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4.5 19 12 6 19.5Z" />
  </Svg>
)

export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4v16M15 4v16" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6h17M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6M18.5 6v13a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
)

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5Z" />
  </Svg>
)

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
)

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" />
  </Svg>
)

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7Z" />
  </Svg>
)

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </Svg>
)

export const IconSmartphone = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2" />
    <path d="M11 18h2" />
  </Svg>
)

export const IconMail = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="m3.5 7 7.4 5.3a2 2 0 0 0 2.2 0L20.5 7" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </Svg>
)

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5" />
  </Svg>
)

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 22s8-3.6 8-9.6V5.5L12 2 4 5.5v6.9C4 18.4 12 22 12 22Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
)

export const IconPanelLeft = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 11a8.5 8.5 0 1 0-.9 5" />
    <path d="M20.5 4.5V11h-6.5" />
  </Svg>
)

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v11" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M4.5 17.5v1.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </Svg>
)

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.5 9.5h17M3.5 14.5h17" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />
  </Svg>
)

export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13.5h5l1.5 3h5l1.5-3h5" />
    <path d="M5.2 5.3 3 13.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4.5l-2.2-8.2A2 2 0 0 0 16.9 4H7.1a2 2 0 0 0-1.9 1.3Z" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Svg>
)

/* The phone-only Home tab. A roof and a door rather than the more common
   roof-only outline: at 17px the plain house silhouette is hard to tell from
   the folder above it, and these two sit four tabs apart on the same bar. */
export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 10.5 12 3.5l8.5 7" />
    <path d="M5.5 9.2V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.2" />
    <path d="M9.8 20v-5.2h4.4V20" />
  </Svg>
)

export const IconDatabase = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
    <path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
  </Svg>
)

export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4" />
    <path d="M5 4.5c1.6-1 3.4-1 5 0s3.4 1 5 0v9c-1.6 1-3.4 1-5 0s-3.4-1-5 0Z" />
  </Svg>
)

export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12 19.5 3.5" />
    <path d="M16 7l2.5 2.5M19 4l2 2" />
  </Svg>
)

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M11 6.5 12.6 4.9a4 4 0 0 1 5.6 5.6L16.6 12" />
    <path d="M13 17.5 11.4 19.1a4 4 0 0 1-5.6-5.6L7.4 12" />
  </Svg>
)

export const IconMaximize = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4H4v5" />
    <path d="M15 4h5v5" />
    <path d="M15 20h5v-5" />
    <path d="M9 20H4v-5" />
  </Svg>
)

export const IconMinimize = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9h5V4" />
    <path d="M20 9h-5V4" />
    <path d="M20 15h-5v5" />
    <path d="M4 15h5v5" />
  </Svg>
)

/* Three tracks with a knob on each — "the settings that are not on screen".
   Not the three plain stacked lines: those read as "menu" in every toolbar in
   this app, and this button opens a panel of *values* (priority, delivery,
   read receipts) rather than a list of destinations. The knobs are what make
   the difference readable at 18px. */
export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h6M14 7h6M4 12h10M18 12h2M4 17h3M11 17h9" />
    <circle cx="12" cy="7" r="2" />
    <circle cx="16" cy="12" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
)

export const IconStar = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z" />
  </Svg>
)

/* --- the image viewer ------------------------------------------------------
   Everything below exists for the full-screen picture viewer. Same 24×24
   stroke grid as the rest; nothing here is decorative, each one labels a
   control that also has a keyboard shortcut. */

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="M21 16l-5-5-5.5 5.5L8 14l-5 5" />
  </Svg>
)

export const IconZoomIn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
    <path d="M10.5 7.5v6M7.5 10.5h6" />
  </Svg>
)

export const IconZoomOut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
    <path d="M7.5 10.5h6" />
  </Svg>
)

/** Turn a quarter clockwise. The mirrored variant is the same path flipped. */
export const IconRotateRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 5v5h-5" />
    <path d="M19.4 10a7.5 7.5 0 1 0-1.1 6.6" />
  </Svg>
)

export const IconRotateLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5v5h5" />
    <path d="M4.6 10a7.5 7.5 0 1 1 1.1 6.6" />
  </Svg>
)

/** Mirror left-to-right: a dashed axis with a solid shape either side of it. */
export const IconFlipH = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v18" strokeDasharray="2.5 2.5" />
    <path d="M9 6L4 12l5 6z" />
    <path d="M15 6l5 6-5 6z" />
  </Svg>
)

export const IconFlipV = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h18" strokeDasharray="2.5 2.5" />
    <path d="M6 9l6-5 6 5z" />
    <path d="M6 15l6 5 6-5z" />
  </Svg>
)

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
)

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
)

/** Row-disclosure affordance — rotated 180° by CSS when the row it opens is expanded. */
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 9l7 7 7-7" />
  </Svg>
)

/** A QR code, drawn as its three finder squares plus a scatter of modules. */
export const IconQr = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM19 14h2M14 19h3m2 0h2m-2-2v0" />
  </Svg>
)

/** Used for the "why this one" disclosure — a question inside a circle. */
export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.2a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4" />
    <path d="M12 17h.01" />
  </Svg>
)

/* --- runecircuit fusion icons -----------------------------------------------
   The `runecircuit` style trades a small, named set of nav icons for these —
   see `RUNE_NAV_ICONS` in `App.tsx`. Each fuses a traditional motif with a
   circuit-diagram element rather than redrawing the same pictogram in a new
   skin, which is why they live here instead of a themed variant of `IconMail`
   and `IconKey`. */

/** A four-lobed cloud-collar (云肩) rosette around a via-dot, with a short
    trace dropping out of it — the mail icon this style stands in for. */
export const IconCloudNode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.2a2.6 2.6 0 0 1 2.4 3.6 2.6 2.6 0 0 1 1.8 4.4 2.6 2.6 0 0 1-1.8 4.4A2.6 2.6 0 0 1 12 19.8a2.6 2.6 0 0 1-2.4-3.6 2.6 2.6 0 0 1-1.8-4.4A2.6 2.6 0 0 1 9.6 7.8 2.6 2.6 0 0 1 12 4.2Z" />
    <circle cx="12" cy="12" r="1.5" />
    <path d="M12 13.5V17" />
  </Svg>
)

/** A 回纹 key-fret spiral standing in for a key's bow, its shaft running
    straight into two right-angle stubs instead of rounded teeth — the code
    icon this style stands in for. */
export const IconKeyNode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 4H4v9h7V8H7" />
    <path d="M11 4h7" />
    <path d="M14 4v3" />
    <path d="M18 4v5" />
  </Svg>
)

/** Six dots in two columns — the grip on a row that can be dragged into a new
    position. Dots rather than the more common three stacked lines: the lines
    read as "menu" everywhere else in this app's own toolbars, and a control
    whose whole job is to say "hold me and move me" cannot afford to be read as
    the one that opens something. */
export const IconGrip = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
)

/** Three dots in a row — "more", the overflow trigger for actions a narrow
    header has no room to show on their own. Horizontal and three, not
    `IconGrip`'s six-dot grid, so the two never read as the same affordance:
    that one means "drag me", this one means "there is more here". */
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
)
