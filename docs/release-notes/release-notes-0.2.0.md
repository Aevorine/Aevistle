# Aevistle 0.2.0

界面统一，这一次是量出来的。

`0.2.0` rather than `0.1.38` because this is the round that stopped patching
screens and fixed what they had in common. Nothing you schedule changes; almost
everything you look at does.

---

## The typeface

The app was set in 宋体 with Times New Roman for Latin. It is now set in whatever
sans your device already uses for its own interface — Segoe UI with 微软雅黑 on
Windows, Roboto with Noto Sans CJK on Android, SF Pro with PingFang on a Mac.

The reason is physical rather than aesthetic. A serif's horizontal strokes are
deliberately thinner than its verticals; on paper at 300+ dpi that is what gives
text its texture, and on a phone at 14px those strokes land on well under one
physical pixel. The renderer then has to choose between dropping them and
smearing them grey, and it does both, glyph by glyph and line by line. That is
the actual cause of 看久了眼睛累 on a screen, and it is not reachable by making
the text bigger or bolder, because the problem is stroke contrast rather than
size. A screen sans has no stroke contrast to lose.

Two side effects, both good:

- **The download is 4.1MB smaller.** The serif had to be bundled because Android
  ships no serif CJK worth naming. A sans is the opposite case — it is what all
  three platforms already set their own UI in — so nothing is bundled and
  nothing is downloaded. `dist/` went from 6.0MB to 1.9MB.
- **No more blank flash of Chinese text on a cold start.** There is no font to
  swap in, so there is nothing to wait for.

If you preferred the serif: it is one declaration in `src/styles/theme.css`
(`--font-sans`), and the file says so.

---

## What was actually wrong

Every number below was measured in the running app, not judged by eye. That is
the difference between this round and the four before it — 界面要统一 has been
asked five times, and each previous answer restyled the screens that were
mentioned.

**17 different sizes for "a thing you tap."** Buttons, inputs, row actions, tabs
and chips were drawn at 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50,
52, 54 and 56 pixels. No single one of those looks wrong; seventeen of them in a
32-pixel range is what makes a row of controls read as assembled from parts
rather than designed. There are now four sizes, and which one a control gets is
decided by what the control *is*.

**Anything you tap is now at least 48 pixels.** That is Android's own documented
minimum, and 44 separate controls were under it — including every button and
every input in the app, which were 46px, two pixels short. Three were badly
short: the formatting toggle on the compose screen was 22px.

**11 layout boundaries, down to 3.** The stylesheet changed shape at 560, 620,
700, 720, 760, 900, 1000, 1100, 1500 and 1600 pixels, and three separate files
in the code held their own disagreeing copies. Dragging a window from wide to
narrow crossed eleven boundaries, and between any two of them the screen was a
mix of two arrangements. The three that remain are Android's own window size
classes (600 / 840 / 1200), they are declared in one place, and a new build fails
if a fourth ever appears.

**A tablet is no longer a stretched phone.** The old boundary was 760px, so a
768px portrait tablet fell on the desktop side of it and was handed a mouse
layout — a two-column grid of settings cards, dialogs floating with scrim down
each side — on a device held in two hands. It now gets the touch layout it
should always have had.

**The message box gets the screen.** The app had 32 responsive rules and every
one of them asked about *width*, while the compose screen's problem was entirely
vertical. On a 1024x768 laptop the message box was 31% of the window; on a
360x800 phone the same app gave it 72%. There is now a height rule, and that one
change fixed the laptop and phone-landscape together:

| Screen | Before | After |
| --- | --- | --- |
| Phone, upright (360x800) | 72% | 87% of the compose view |
| Tablet, upright (768x1024) | 72% | 72% |
| **Laptop / tablet sideways (1024x768)** | **31%** | **58%** |
| Phone, sideways (800x360) | 32% | 32%, with a shorter tab bar |

---

## Bugs that were invisible in a screenshot

Each of these was found by measuring the real page, and each had been live for
some time. None of them errors, which is why they lasted.

- **The send-time button was two pixels taller than everything beside it.** A
  `font: inherit` three files away was resetting its line-height — `font` is a
  shorthand, and every property it does not mention is reset. So the button sat
  at 50px in a row of 48s, and the row read as slightly off with nothing to
  point at.
- **The 正文 label was a size smaller than its four siblings.** The rule that
  sets compose labels to 18.67px used a direct-child selector. The body field is
  the one field that grew a toolbar row, so its label moved one level down and
  quietly stopped matching — falling back to the 16px default forty lines up.
- **The chip close cross was declared at two different sizes** in two places
  that both matched. The second silently won.
- **The formatting toggle's 48px minimum had never run.** It lived behind a
  touch-pointer media query, and a headless browser, devtools device emulation
  and a CI runner all report a mouse — so every check of it passed on a machine
  where it did not apply.
- **13 text-on-background pairs across the seven visual styles were under the
  accessibility minimum.** All 13 were the tertiary text colour on the deepest
  surface — a surface no comment in the theme file had ever quoted a ratio
  against. All 477 pairs are now computed on every build.

---

## Phone and tablet

- **Sideways on a phone**, the tab bar drops to its icons (56px to 44px). It was
  costing 16% of a 360px-tall screen to label five tabs the same person had just
  read upright.
- **Notches on the side are paid for.** Landscape rules previously only paid the
  top and bottom insets, so on a phone turned sideways the tab bar could run
  under the camera cutout and the first tab was unreachable.
- **One filled button per screen.** A second one gives up its fill and becomes an
  outline. Two filled buttons do not mean two important actions; they mean no
  primary action.

---

## Under the hood

Nothing here changes what the app does. It changes whether the next round of this
is possible.

- **`app.css` was 10,805 lines in one file.** It is now 20 modules, and the split
  is provably lossless: the built stylesheet is byte-identical, 170,625 bytes
  before and after. Three of the modules are named for what they are rather than
  tidied up — `14-growth.css`, `15-compose-narrow.css` and `17-phone.css` are
  4,300 lines of earlier rounds patching each other's output.
- **`src/core/` was 77 files in one folder.** It is now five areas: `mail`,
  `schedule`, `sync`, `platform`, `ops`.
- **That split blinded seven check scripts**, which had the old paths written into
  them and went on reporting "all clear" against files that no longer held
  anything. One of them cheerfully verified 187 tokens in a file that had become
  twenty `@import` lines. They now compute the paths.
- **Three new gates**, so a sixth round of 界面不统一 fails the build instead of
  reaching you: one that allows exactly three widths and two heights, one that
  computes every colour pair, and one that walks the real page at four device
  sizes — because every bug in the section above is invisible in the stylesheet
  and plain in the rendered DOM.
- 25 older release notes moved from the repository root into
  `docs/release-notes/`.

All 58 project checks pass.

---

## Verifying this download

```
sha256sum -c SHA256SUMS.txt
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
```

The signing key and its fingerprint are in [`SECURITY.md`](../../SECURITY.md).
