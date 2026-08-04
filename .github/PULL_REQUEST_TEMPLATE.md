<!--
Thanks for this. Delete any section that does not apply — an honest short PR
description beats a fully filled template that says nothing.
-->

## What this changes

<!-- One or two sentences. What is different after this is merged. -->

## Why

<!-- The problem it solves. Link the issue if there is one: Fixes #123 -->

## How to check it

<!--
What a reviewer should do to see it working, or what you did. "Scheduled one
for +2 min, closed the window, it arrived" is a perfectly good answer.
-->

## Checklist

- [ ] `npm run check` passes (typecheck, the `check:*` scripts, `audit:self`, `audit:deps`)
- [ ] One thing at a time — no unrelated reformatting mixed in
- [ ] If this touches the mail path (`electron/mailer.ts`, `android/.../MailSender.java`,
      `src/core/validate.ts`), the change is made on **both** platforms — they are kept
      deliberately symmetric
- [ ] If this adds or changes user-facing text, `src/i18n/en.ts` is updated and
      `npm run check:i18n` passes for all six locales
- [ ] No credential, token, personal address or local path is included in the diff
- [ ] This is not a security fix — those go through
      [private reporting](https://github.com/Aevorine/Aevistle/security/advisories/new),
      not a public pull request
