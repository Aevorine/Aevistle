/**
 * The gate on verification-code extraction.
 *
 * This exists because the feature failed in the one way that does not announce
 * itself: a Microsoft password-reset mail whose code was `390089` displayed
 * `98052`, the postal code of Redmond, and nothing anywhere logged, threw or
 * looked wrong. The screen was confidently, legibly incorrect.
 *
 * So the corpus is written the way that failure would have been caught. Every
 * case states the *expected* answer, and — this is the part that matters —
 * roughly half of them expect `null`. A rule that raises the hit rate by also
 * offering a postcode, a phone number and a copyright year is not an
 * improvement, and a corpus made only of positives cannot tell the difference.
 *
 * `falsePositives` is therefore the metric with the hard ceiling. Missing a
 * code costs one trip back to the mail; showing the wrong one costs a failed
 * login and the minutes spent working out why the digits on screen do not work.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MS_FOOTER = 'Microsoft Corporation, One Microsoft Way, Redmond, WA 98052'

/**
 * Bodies are lightly redacted real-world shapes, not invented ones: the
 * wording, the footer, and where the digits sit relative to the announcement
 * are exactly what makes each case hard.
 */
const CASES = [
  // --- the reported bug, and the three things that had to line up ----------
  {
    name: 'Microsoft zh — 代码, not 验证码 (the reported bug)',
    from: 'Microsoft <account-security-noreply@accountprotection.microsoft.com>',
    subject: 'Microsoft 帐户密码重置代码',
    body: `Microsoft 帐户\n密码重置代码\n请使用此代码为个人 Microsoft 帐户 li**d@outlook.com 重置密码。\n你的代码如下: 390089\n谢谢!\nMicrosoft 帐户团队\n隐私声明\n${MS_FOOTER}`,
    expect: '390089',
  },
  {
    name: 'Microsoft zh — code split one digit per element',
    from: 'Microsoft <noreply@microsoft.com>',
    subject: 'Microsoft 帐户密码重置代码',
    body: `密码重置代码\n你的代码如下: 3 9 0 0 8 9\n谢谢!\n${MS_FOOTER}`,
    expect: '390089',
  },
  {
    name: 'Microsoft en — postcode must never win on its own',
    from: 'Microsoft <noreply@microsoft.com>',
    subject: 'Microsoft account security info',
    body: `Microsoft account\nThanks for using Microsoft.\n${MS_FOOTER}`,
    expect: null,
  },
  {
    name: 'zero-width characters inside the code',
    from: 'Example <noreply@example.com>',
    subject: 'Your verification code',
    body: 'Your verification code is 48​29​13. It expires in 10 minutes.',
    expect: '482913',
  },

  // --- ordinary positives, six locales -------------------------------------
  { name: 'en plain', from: 'x@example.com', subject: 'Verification code', body: 'Your code is 615204. Do not share it.', expect: '615204' },
  { name: 'en, code before keyword', from: 'x@example.com', subject: '', body: '482913 is your verification code.', expect: '482913' },
  { name: 'zh 验证码', from: 'x@example.cn', subject: '登录验证', body: '您的验证码是 947500，5 分钟内有效。', expect: '947500' },
  { name: 'zh 动态密码', from: 'x@example.cn', subject: '', body: '【某银行】您的动态密码为 238104，请勿泄露。', expect: '238104' },
  { name: 'fr', from: 'x@example.fr', subject: '', body: 'Votre code de vérification est 731905. Il expire dans 15 minutes.', expect: '731905' },
  { name: 'es', from: 'x@example.es', subject: '', body: 'Tu código de verificación es 204518.', expect: '204518' },
  { name: 'ru', from: 'x@example.ru', subject: '', body: 'Ваш код подтверждения: 883217', expect: '883217' },
  { name: 'ar', from: 'x@example.ae', subject: '', body: 'رمز التحقق الخاص بك هو 559431', expect: '559431' },
  { name: 'Google G- prefix', from: 'Google <no-reply@accounts.google.com>', subject: 'Security alert', body: 'G-773311 is your Google verification code.', expect: '773311' },
  { name: 'GitHub device code', from: 'GitHub <noreply@github.com>', subject: 'Device verification', body: 'Your GitHub verification code is 049182.', expect: '049182' },
  { name: 'code in the subject line', from: 'x@example.com', subject: 'Your code is 660412', body: 'Please enter the code shown in the subject of this message.', expect: '660412' },
  { name: 'eight-digit code', from: 'x@example.com', subject: '', body: 'Your one-time password is 51820394.', expect: '51820394' },
  { name: 'grouped with a space', from: 'x@example.com', subject: '', body: 'Your access code: 947 500', expect: '947500' },

  // --- negatives: the numbers that used to win --------------------------
  { name: 'US postcode in a signature', from: 'x@example.com', subject: 'Newsletter', body: 'Thanks for reading.\nAcme Inc, 500 Terry Francois Blvd, San Francisco, CA 94158', expect: null },
  { name: 'Chinese postcode', from: 'x@example.cn', subject: '通知', body: '感谢您的支持。\n地址：深圳市南山区科技南路 12 号 3 栋 405 室，邮编 518057', expect: null },
  { name: 'support hotline', from: 'x@example.cn', subject: '账单通知', body: '如有疑问请拨打客服热线 400-820-8820。', expect: null },
  { name: 'copyright year', from: 'x@example.com', subject: 'Welcome', body: 'Welcome aboard.\n© 2024 Example Corp. All rights reserved.', expect: null },
  { name: 'price', from: 'x@example.com', subject: 'Receipt', body: 'Thank you for your purchase. Total: $1299.00 charged to your card.', expect: null },
  { name: 'order number in a long mail', from: 'x@example.com', subject: 'Your order', body: `Your order 88401277 has shipped and should arrive on Tuesday. ${'Tracking details are available in your account. '.repeat(12)}`, expect: null },
  { name: 'lone number in a long newsletter', from: 'x@example.com', subject: 'This week', body: `Our roundup of the week. ${'A great deal of prose about nothing in particular. '.repeat(20)} 482913 people read us last month.`, expect: null },
  { name: 'year alone', from: 'x@example.com', subject: 'Happy new year', body: 'Wishing you all the best for 2025.', expect: null },
  { name: 'digits inside the recipient address', from: 'x@example.com', subject: 'Hello', body: 'This message was sent to someone1234@example.com because you signed up.', expect: null },
  { name: 'phone with country code', from: 'x@example.com', subject: 'Contact', body: 'Call us on +1 (800) 555-0199 any time.', expect: null },
  { name: 'two unannounced numbers', from: 'x@example.com', subject: 'Hi', body: 'Reference 448201 relates to case 771043.', expect: null },
  { name: 'keyword present but the code is gone', from: 'x@example.com', subject: 'Your verification code', body: `The code is in the image above.\n${MS_FOOTER}`, expect: null },

  // --- links ---------------------------------------------------------------
  {
    name: 'magic sign-in link',
    from: 'Example <noreply@example.com>',
    subject: 'Sign in to Example',
    body: 'Click below to sign in. This link expires in 15 minutes.',
    links: [{ url: 'https://example.com/auth/magic?token=abcdef0123456789abcdef', text: 'Sign in' }],
    expectLink: { purpose: 'signin', risks: ['oneTimeToken'] },
  },
  {
    name: 'password reset link outranks the unsubscribe footer',
    from: 'Example <noreply@example.com>',
    subject: 'Reset your password',
    body: 'Someone asked to reset your password.',
    links: [
      { url: 'https://example.com/unsubscribe?u=99', text: 'Unsubscribe' },
      { url: 'https://example.com/account/reset-password?token=aaaaaaaaaaaaaaaaaaaa', text: 'Reset password' },
    ],
    expectLink: { purpose: 'resetPassword' },
  },
  {
    name: 'off-site and unencrypted are both flagged',
    from: 'Bank <noreply@mybank.example>',
    subject: 'Verify your account',
    body: 'Please verify your account.',
    links: [{ url: 'http://totally-different.example/verify?token=aaaaaaaaaaaaaaaaaaaa', text: 'Verify' }],
    expectLink: { purpose: 'verifyEmail', risks: ['insecure', 'oneTimeToken', 'crossDomain'] },
  },
  {
    name: 'brand family is not cross-domain',
    from: 'Microsoft <noreply@microsoft.com>',
    subject: 'Sign in',
    body: 'Sign in to continue.',
    links: [{ url: 'https://login.live.com/oauth20_authorize.srf?client_id=00000000', text: 'Sign in' }],
    expectLink: { purpose: 'signin', notRisks: ['crossDomain'] },
  },
  {
    name: 'a tracking pixel is never the link',
    from: 'News <news@example.com>',
    subject: 'This week',
    body: 'Read on.',
    links: [{ url: 'https://click.example.com/open/pixel.gif?id=1', text: '' }],
    expectLink: null,
  },

  // --- validity ------------------------------------------------------------
  { name: 'validity en', from: 'x@example.com', subject: '', body: 'Your code is 615204 and expires in 10 minutes.', expect: '615204', expectValidityMs: 600_000 },
  { name: 'validity zh', from: 'x@example.cn', subject: '', body: '您的验证码是 947500，15 分钟内有效。', expect: '947500', expectValidityMs: 900_000 },
  { name: 'one-time wording', from: 'x@example.com', subject: '', body: 'Your single-use code is 300921.', expect: '300921', expectOneTime: true },
  { name: 'a 90-day footer is not this code expiring', from: 'x@example.com', subject: '', body: 'Your code is 481027. Passwords are valid for 90 days.', expect: '481027', expectValidityMs: null },

  // --- mixed-token blanking (the ReDoS fix must keep doing its job) --------
  { name: 'mixed alnum tracking token does not blot out the real code', from: 'x@example.com', subject: '', body: 'Tracking ref ORDER8842X shipped today. Your verification code is 552901.', expect: '552901' },
  { name: 'mixed alnum token alone is not mistaken for a code', from: 'x@example.com', subject: '', body: 'Please reference ticket AB12CD34 when you contact support.', expect: null },
]

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-codes-'))

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'src/core/ops/codeExtract.ts')}"`,
      '--bundle',
      '--format=esm',
      `--outfile="${join(out, 'ce.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { extractFromMessage, learnRule } = await import(pathToFileURL(join(out, 'ce.mjs')).href)

let falsePositives = 0
let misses = 0
let wrong = 0
let passed = 0
const problems = []

for (const c of CASES) {
  const hits = extractFromMessage({
    subject: c.subject ?? '',
    bodyText: c.body,
    links: c.links ?? [],
    from: c.from,
  })
  const code = hits.find((h) => h.kind === 'code') ?? null
  const link = hits.find((h) => h.kind === 'link') ?? null

  let ok = true

  if ('expect' in c) {
    if (c.expect === null && code) {
      falsePositives++
      ok = false
      problems.push(`FALSE POSITIVE  ${c.name}: expected nothing, got ${code.value}`)
    } else if (c.expect !== null && !code) {
      misses++
      ok = false
      problems.push(`MISS            ${c.name}: expected ${c.expect}, got nothing`)
    } else if (c.expect !== null && code.value !== c.expect) {
      wrong++
      ok = false
      problems.push(`WRONG VALUE     ${c.name}: expected ${c.expect}, got ${code.value}`)
    }
  }

  if ('expectLink' in c) {
    if (c.expectLink === null && link) {
      falsePositives++
      ok = false
      problems.push(`FALSE POSITIVE  ${c.name}: expected no link, got ${link.value}`)
    } else if (c.expectLink && !link) {
      misses++
      ok = false
      problems.push(`MISS            ${c.name}: expected a link, got nothing`)
    } else if (c.expectLink && link) {
      if (link.analysis.purpose !== c.expectLink.purpose) {
        wrong++
        ok = false
        problems.push(
          `WRONG PURPOSE   ${c.name}: expected ${c.expectLink.purpose}, got ${link.analysis.purpose}`,
        )
      }
      for (const risk of c.expectLink.risks ?? []) {
        if (!link.analysis.risks.includes(risk)) {
          wrong++
          ok = false
          problems.push(`MISSING RISK    ${c.name}: expected ${risk}, got [${link.analysis.risks}]`)
        }
      }
      for (const risk of c.expectLink.notRisks ?? []) {
        if (link.analysis.risks.includes(risk)) {
          falsePositives++
          ok = false
          problems.push(`SPURIOUS RISK   ${c.name}: did not expect ${risk}`)
        }
      }
    }
  }

  if ('expectValidityMs' in c) {
    const got = code?.validity?.ms ?? null
    if (got !== c.expectValidityMs) {
      wrong++
      ok = false
      problems.push(`WRONG VALIDITY  ${c.name}: expected ${c.expectValidityMs}, got ${got}`)
    }
  }
  if ('expectOneTime' in c && code?.validity?.oneTime !== c.expectOneTime) {
    wrong++
    ok = false
    problems.push(`WRONG ONE-TIME  ${c.name}: expected ${c.expectOneTime}`)
  }

  /* Explainability is a promise the screen makes, so it is checked like any
     other behaviour: a hit that cannot say why it was chosen is a regression
     even when the value is right. */
  if (code && (!Array.isArray(code.reasons) || code.reasons.length === 0)) {
    wrong++
    ok = false
    problems.push(`NO REASON       ${c.name}: ${code.value} was picked with no stated reason`)
  }

  if (ok) passed++
}

/* B8 — a correction has to survive into the *next* mail from that sender, which
   is the only thing that makes it worth a press. Same sender, new code. */
{
  const from = 'Microsoft <noreply@microsoft.com>'
  const first = `会员通知\n参考号 884012\n服务编号 720913\n${MS_FOOTER}`
  const rules = learnRule([], { from, rejected: '884012', preferred: '720913', bodyText: first })
  const later = `会员通知\n参考号 884012\n服务编号 551208\n${MS_FOOTER}`
  const hits = extractFromMessage({ subject: '', bodyText: later, from, rules })
  const code = hits.find((h) => h.kind === 'code')
  if (!code || code.value !== '551208') {
    wrong++
    problems.push(
      `RULE NOT LEARNED: after correcting to the number after 服务编号, the next mail gave ${code?.value ?? 'nothing'} instead of 551208`,
    )
  } else {
    passed++
  }
  const rejected = extractFromMessage({ subject: '', bodyText: first, from, rules })
    .find((h) => h.kind === 'code')
  if (rejected?.value === '884012') {
    falsePositives++
    problems.push('RULE NOT APPLIED: the rejected value came back for the same sender')
  } else {
    passed++
  }
}

/*
 * ReDoS regression — a mail this size used to cost the old lookahead regex
 * ~1.8s (measured on a 40,000-character body of the same shape); a hostile
 * IMAP message can hand this function a body like this with no user action,
 * so this has to stay fast, not just correct. `%` sits inside the token
 * character class but outside the old regex's lookbehind exclusion set,
 * which is what made every one of these positions a fresh, expensive retry.
 */
{
  const adversarial = 'a1%'.repeat(40_000) // 120,000 chars, well past the 64 KiB cap
  const start = performance.now()
  extractFromMessage({ subject: '', bodyText: adversarial, from: 'x@example.com' })
  const ms = performance.now() - start
  const BUDGET_MS = 300
  if (ms > BUDGET_MS) {
    wrong++
    problems.push(`REDOS REGRESSION: adversarial body took ${ms.toFixed(0)}ms, budget is ${BUDGET_MS}ms`)
  } else {
    passed++
  }
}

rmSync(out, { recursive: true, force: true })

const total = CASES.length + 3
for (const line of problems) console.error(`  ${line}`)

console.log(
  `\ncheck:code-extract — ${passed}/${total} passed · ${falsePositives} false positive(s) · ${misses} miss(es) · ${wrong} wrong`,
)

/*
 * False positives fail the build outright. Misses are reported and tolerated:
 * the corpus deliberately contains mails whose code is genuinely unrecoverable
 * (it was in an image), and treating "said nothing" as a build break is how a
 * gate gets loosened until it stops meaning anything.
 */
if (falsePositives > 0 || wrong > 0) {
  console.error('\nFAILED — a wrong answer shown confidently is worse than no answer.')
  process.exit(1)
}
if (misses > 2) {
  console.error(`\nFAILED — ${misses} misses is more than the two the corpus expects.`)
  process.exit(1)
}
console.log('All clear.')
