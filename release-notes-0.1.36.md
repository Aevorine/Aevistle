# Aevistle 0.1.36

A large round — 34 items from a full desktop+Android review, implemented and independently
re-verified before this build. Grouped by area below; the full evidence trail (files touched,
what each fix actually changed, what's still open) lives in this round's working notes.

## Compose screen

The compose screen is the most-used screen in the app, so it got the most scrutiny.
A first-run/no-account state was showing the same "you don't have a send account yet"
warning twice — once from the health strip, once from the compose screen's own copy —
which cost ~80px and pushed the screen past one-screen-fits-without-scrolling on a common
1366×768 laptop. The duplicate is gone; removing it also surfaced a second bug (a CSS rule
that gave the message box extra height whenever a warning banner was showing had been
written against the banner that just got deleted, so the fix would have made the overflow
*worse*, not better, if shipped alone — the rule now also recognizes the health strip's own
warning). The "Preview" button's tooltip, when the button is greyed out because the draft is
still empty, now says why instead of repeating its own name. The link button in the formatting
toolbar was a raw color emoji next to six flat monochrome glyphs; it's now the same flat
icon set as everything else. A CSS conflict that stranded action buttons in banners (account
warnings, the post-send result strip, OAuth prompts) with a large gap before the banner's
true right edge is fixed — those buttons now sit flush right everywhere a banner has one.

One genuine correctness fix rode along with the visual work: a "send once" schedule was
describing itself with the generic "won't repeat" sentence instead of the one thing this
screen exists to answer — *when*. It now shows the actual date and time for one-off sends.

## Mail accounts and inbox

Outlook/Hotmail/Live/MSN addresses require Microsoft sign-in in this build, and Microsoft's
side of that isn't configured yet (that needs the app's Microsoft developer registration
to go through, not a code change). Previously the app let you fill in the whole add-account
flow before saying so at the last step; it now says so as soon as you type the address, with
no dead-end "Connect" button offered. Accounts added by one-click sign-in (as opposed to a
password) were silently missing from the real-time inbox watcher that verification codes rely
on for near-instant delivery — those accounts were falling back to the slower polling
schedule with no indication anything was different. They now get the same real-time watcher
password accounts do. The inbox only ever shows the newest 50 messages per account and
fully replaces its list on every sync — mail older than that has always quietly dropped out
of view once a mailbox passes 50 messages, even though it's still on the server. There's now
a visible note when that's happening; a "load older mail" button is a larger follow-up not
done this round (noted below).

## Android — matching the desktop experience

The Android status bar now follows the app's own theme instead of staying locked to
whatever it looked like at splash-screen time — a longstanding piece of dead code (a
"follows system theme" Activity theme that nothing ever switched to) is now actually live.
Cold start in dark mode/dark skin no longer flashes white before content paints, matching
what desktop has done for a while. Core settings — most importantly the send-time picker,
the single most emphasized control in this app — now open a custom-built panel instead of
Android's native system picker; recurrence's date/time fields got the same treatment.
(17 more native dropdowns/pickers across less-trafficked screens are flagged for a future
round rather than rushed through this one.) A battery-optimization/power-management check
and one-tap fix now sits in Settings next to the existing exact-alarm check — the most common
way a scheduled send silently never fires on Android is a phone manufacturer's power saver
freezing the app with zero error shown, and this gives it the same visibility that problem
class already had. Failed-send notifications now carry a "Retry now" action, and new-mail
notifications a "Mark read" action — both one-tap-from-the-notification-shade, matching the
"Copy" action verification-code notifications already had. The Android home screen now has
a visible search entry point into the same command palette Ctrl+K opens on desktop, which
previously only a physical keyboard could reach — ironic, since Android is the platform that
collapses the most screens behind that entry point. A home-screen widget shows "next
scheduled send" the way the Windows tray already does, refreshing when a job is armed, fires,
or the schedule otherwise changes. New-mail background notifications used to always speak the
phone's system language regardless of the app's own language setting; they now follow the
app's setting. Long-press the app icon for quick shortcuts into composing or checking
verification codes. A registered-but-inert boot receiver (it could never actually fire, by
Android's own rules, without a declaration this app never made) has been removed rather than
left as misleading dead code.

## Everywhere

The command palette (Ctrl+K on desktop) can now find a received email by sender or subject —
previously it searched contacts, templates, and scheduled jobs, but not the inbox, despite
that being the single most common thing a search box does in a mail app. The taskbar icon
now carries a small badge for unread mail / pending sends, so a minimized or tray-only window
still shows at a glance whether anything needs attention. Update checks used to run exactly
once per launch, which made sense for a foreground app but not for one designed to sit in the
tray unattended for weeks — it now rechecks roughly daily while running, without reintroducing
a pointless "already latest" toast on every boot. Contacts can now be bulk-imported from a CSV
file on desktop, or picked straight from the phone's own contacts app on Android, instead of
being typed in one at a time. Full-screen image viewer buttons were below the usual touch-target
minimum on phones; they're bigger now on touch/narrow screens. Empty list screens (no scheduled
jobs, no contacts, no templates yet) now center their icon and message instead of pinning them
to the top with a large blank area below.

## App icon

The app icon — Windows taskbar, Start menu, Android home screen, install wizard — was still
the original 3D gold-trimmed glass envelope, from before the interface settled into its current
flat, solid-color, no-gradient look. It's been redrawn to match: a flat envelope mark in the
app's own accent blue, no bevels or gradients, generated at every required size for both
platforms. A couple of unused placeholder icon files left over from the original Capacitor
template were removed rather than kept around unreferenced.

## Behind the scenes

New automated coverage: the cross-device sync-conflict resolution logic (previously untested
by any of this project's ~80 check scripts, despite being the one function that decides whose
edit wins when two devices touch the same reminder) now has one; an accessibility pass runs
against the key screens via axe-core; a dedicated check renders the app in Arabic and checks
for layout breakage, since the existing i18n check only compares translation keys, never actual
RTL rendering. The dependency-vulnerability check now surfaces moderate-severity findings by
name instead of only ever reporting high-and-above. An ESLint config with the React Hooks rules
enabled is in the repo, ready to catch a whole class of "forgot to list a dependency, screen
shows stale data" bugs — but it can't actually run yet: `typescript-eslint` doesn't support the
TypeScript 7.0 compiler this project is on (an upstream compatibility gap, tracked as
typescript-eslint/typescript-eslint#10940), so `npm run check:lint` exists but isn't wired into
the main check chain until that's resolved upstream, to avoid failing every future check run on
something no local fix can address.

## Known gaps this round didn't close

- Loading mail older than the newest 50 per account (a visible notice ships this round; the
  actual pagination is a larger change involving the inbox sync's merge logic, left for later).
- 17 native Android dropdowns/date-time pickers on less-trafficked screens still open the
  system control rather than the app's own styled one (send-time and recurrence's fields —
  the two most-used — are done).
- `npm run check:lint` can't run until `typescript-eslint` adds TypeScript 7 support upstream.
