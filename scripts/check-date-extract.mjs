/**
 * The gate on meeting / deadline extraction.
 *
 * Written to the same rule as `check-code-extract.mjs`, and for the same
 * reason. That feature failed in the one way that does not announce itself — a
 * password-reset mail whose code was `390089` displayed `98052`, the postal
 * code of Redmond, and nothing logged, threw or looked wrong. Dates have more
 * ways to do that, not fewer: `v2.10.3`, `24/7`, `192.168.1.100`, an order
 * number, a copyright year and the `Sent:` line of a forwarded mail all read as
 * a perfectly good date, and one of them silently becomes a reminder that fires
 * on a day nothing is happening.
 *
 * So roughly half of the corpus expects *nothing*, and the two error kinds are
 * not treated alike:
 *
 *   - a **false positive** fails the build. A wrong date offered as a one-press
 *     action costs a meeting attended at the wrong time.
 *   - a **false negative** is reported and tolerated. It costs one read of the
 *     mail, which is what the user was doing anyway.
 *
 * A wrong *value* on a case that expected a hit counts as a false positive: the
 * card showed a date, confidently, and it was the wrong one.
 *
 * `--selftest` breaks the extractor in the two ways that matter — the strike-out
 * pass removed, and relative phrases anchored to the wall clock instead of
 * `receivedAt` — and requires that this file go red. A guard nobody has watched
 * fail is not yet a guard.
 */

// Set before anything reads the clock or resolves a wall time. The whole corpus
// is resolved in a zone well west of UTC, where an off-by-one-day bug in
// all-day handling is visible instead of cancelling out.
process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const selftest = process.argv.includes('--selftest')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(root, 'src/core/dateExtract.ts')

/**
 * The two known-bad versions, applied to the source text before bundling.
 *
 * Textual rather than a flag in the module, so the shipped file carries no
 * "make me wrong" switch: the guard proves it can catch a regression in code
 * that has no idea it is being tested.
 */
const BREAKAGES = [
  {
    name: 'strike-out pass removed',
    from: 'for (const re of NEGATIVES) out = blank(out, re)',
    to: 'for (const re of NEGATIVES) if (!re) out = blank(out, re)',
  },
  {
    name: 'relative phrases anchored to the wall clock',
    from: 'const anchor = fieldsOf(receivedAt)',
    to: 'const anchor = fieldsOf(Date.now())',
  },
]

let source = await readFile(SOURCE, 'utf8')
if (selftest) {
  for (const breakage of BREAKAGES) {
    if (!source.includes(breakage.from)) {
      console.error(`  SELFTEST CANNOT RUN: "${breakage.from}" is no longer in the source.`)
      process.exit(1)
    }
    source = source.replace(breakage.from, breakage.to)
  }
}

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-dates-'))
const out = path.join(dir, 'de.mjs')
await build({
  stdin: { contents: source, resolveDir: path.join(root, 'src/core'), loader: 'ts' },
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const { extractDates, dateOrderFor } = await import(pathToFileURL(out).href)
await rm(dir, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// The anchor: Wednesday 4 March 2026, 10:00 local.
// ---------------------------------------------------------------------------

const RECEIVED = new Date(2026, 2, 4, 10, 0, 0).getTime()

/** A local wall time as an instant, so expectations read as a person writes them. */
const L = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime()

const ICS_TIMED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:9f3@example.com',
  'DTSTAMP:20260304T090000Z',
  'SUMMARY:Quarterly review',
  'LOCATION:Room 4B',
  'DTSTART:20260312T220000Z',
  'DTEND:20260312T230000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const ICS_ALLDAY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:allday@example.com',
  'SUMMARY:Team offsite',
  'DTSTART;VALUE=DATE:20260312',
  'DTEND;VALUE=DATE:20260313',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const MS_FOOTER =
  'Example Corp, 500 Terry Francois Blvd, San Francisco, CA 94158\n© 2024 Example Corp. All rights reserved.\nUnsubscribe | Privacy policy'

/**
 * Bodies are lightly redacted real-world shapes. The wording, the footer and
 * where the digits sit relative to the announcement are what make each case
 * hard; inventing tidier ones would test nothing.
 */
const CASES = [
  // --- English -------------------------------------------------------------
  {
    name: 'en — written date and a time',
    lang: 'en',
    subject: 'Project meeting',
    body: 'Hi all,\nOur project meeting is on March 12, 2026 at 14:30 in Room B.\nThanks',
    expect: { at: L(2026, 3, 12, 14, 30), allDay: false, kind: 'meeting' },
  },
  {
    name: 'en — "tomorrow at 3" is the afternoon after it was sent',
    lang: 'en',
    subject: 'Design review',
    body: 'Can we have the design review meeting tomorrow at 3?',
    expect: { at: L(2026, 3, 5, 15, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'en — next Monday at 9am',
    lang: 'en',
    subject: 'Weekly sync',
    body: 'Let us move the sync to next Monday at 9am.',
    expect: { at: L(2026, 3, 9, 9, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'en — "due in 3 days"',
    lang: 'en',
    subject: 'Submission',
    body: 'The quarterly report is due in 3 days. Please send it to me directly.',
    expect: { at: L(2026, 3, 7), allDay: true, kind: 'deadline' },
  },
  {
    name: 'en — RSVP by a named weekday',
    lang: 'en',
    subject: 'Team offsite',
    body: 'Please RSVP by Friday so we can book the room.',
    expect: { at: L(2026, 3, 6), allDay: true, kind: 'deadline' },
  },
  {
    name: 'en — appointment with am/pm',
    lang: 'en',
    subject: 'Appointment confirmed',
    body: 'Your appointment is confirmed for 12 March 2026 at 9:15 am. Please arrive early.',
    expect: { at: L(2026, 3, 12, 9, 15), allDay: false, kind: 'appointment' },
  },
  {
    name: 'en — the date is in the subject, the body says nothing',
    lang: 'en',
    subject: 'Meeting on 12 March 2026',
    body: 'Agenda to follow.',
    expect: { at: L(2026, 3, 12), allDay: true, kind: 'meeting' },
  },
  {
    name: 'en — ISO date written in prose',
    lang: 'en',
    subject: 'Workshop',
    body: 'The workshop is scheduled for 2026-03-20 at 10:00.',
    expect: { at: L(2026, 3, 20, 10, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'en — submission closes on a date',
    lang: 'en',
    subject: 'Call for papers',
    body: `Submission closes on April 2, 2026.\n${MS_FOOTER}`,
    expect: { at: L(2026, 4, 2), allDay: true, kind: 'deadline' },
  },
  {
    name: 'en — an explicit UTC offset is honoured exactly',
    lang: 'en',
    subject: 'Kick-off call',
    body: 'The kick-off call is on 12 March 2026 at 14:00 UTC+8.',
    expect: { at: Date.UTC(2026, 2, 12, 6, 0), allDay: false, kind: 'meeting' },
  },

  // --- 简体中文 -------------------------------------------------------------
  {
    name: 'zh — 明天下午三点',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '会议通知',
    body: '各位好：\n会议定于明天下午三点在 3 号会议室召开，请准时参加。',
    expect: { at: L(2026, 3, 5, 15, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'zh — 下周一上午10点',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '例会',
    body: '下周一上午10点开例会，地点：三楼会议室。',
    expect: { at: L(2026, 3, 9, 10, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'zh — 年月日 加 下午时刻',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '项目评审',
    body: '评审会时间：2026年4月3日 下午2:30，请提前十分钟到场。',
    expect: { at: L(2026, 4, 3, 14, 30), allDay: false, kind: 'meeting' },
  },
  {
    name: 'zh — 三天后截止',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '报名通知',
    body: '请注意，本次报名三天后截止，逾期不再受理。',
    expect: { at: L(2026, 3, 7), allDay: true, kind: 'deadline' },
  },
  {
    name: 'zh — 面试预约',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '面试安排',
    body: '面试时间：3月12日 上午9点，地点：科技园 B 座。',
    expect: { at: L(2026, 3, 12, 9, 0), allDay: false, kind: 'appointment' },
  },
  {
    name: 'zh — 本周五 14:00',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '视频会议',
    body: '本周五 14:00 召开视频会议，链接稍后发送。',
    expect: { at: L(2026, 3, 6, 14, 0), allDay: false, kind: 'meeting' },
  },

  // --- Français ------------------------------------------------------------
  {
    name: 'fr — le 12 mars 2026 à 14h30',
    lang: 'fr',
    locale: 'fr-FR',
    subject: 'Réunion d’équipe',
    body: 'Bonjour,\nLa réunion aura lieu le 12 mars 2026 à 14h30 en salle B.',
    expect: { at: L(2026, 3, 12, 14, 30), allDay: false, kind: 'meeting' },
  },
  {
    name: 'fr — répondre dans 3 jours',
    lang: 'fr',
    locale: 'fr-FR',
    subject: 'Appel d’offres',
    body: 'Merci de répondre dans 3 jours, c’est le dernier délai.',
    expect: { at: L(2026, 3, 7), allDay: true, kind: 'deadline' },
  },
  {
    name: 'fr — rendez-vous demain à 10h',
    lang: 'fr',
    locale: 'fr-FR',
    subject: 'Votre rendez-vous',
    body: 'Votre rendez-vous est confirmé demain à 10h.',
    expect: { at: L(2026, 3, 5, 10, 0), allDay: false, kind: 'appointment' },
  },

  // --- Español -------------------------------------------------------------
  {
    name: 'es — el 12 de marzo de 2026 a las 15:00',
    lang: 'es',
    locale: 'es-ES',
    subject: 'Reunión de proyecto',
    body: 'Hola,\nLa reunión será el 12 de marzo de 2026 a las 15:00 en la sala B.',
    expect: { at: L(2026, 3, 12, 15, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'es — el plazo vence en 5 días',
    lang: 'es',
    locale: 'es-ES',
    subject: 'Documentación pendiente',
    body: 'Recuerda que el plazo vence en 5 días.',
    expect: { at: L(2026, 3, 9), allDay: true, kind: 'deadline' },
  },
  {
    name: 'es — cita mañana a las 9:30',
    lang: 'es',
    locale: 'es-ES',
    subject: 'Tu cita',
    body: 'Tu cita es mañana a las 9:30 en la clínica central.',
    expect: { at: L(2026, 3, 5, 9, 30), allDay: false, kind: 'appointment' },
  },

  // --- Русский -------------------------------------------------------------
  {
    name: 'ru — в понедельник в 15:00',
    lang: 'ru',
    locale: 'ru-RU',
    subject: 'Встреча',
    body: 'Добрый день!\nВстреча состоится в понедельник в 15:00 в переговорной.',
    expect: { at: L(2026, 3, 9, 15, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'ru — 12 марта 2026 г. в 14:30',
    lang: 'ru',
    locale: 'ru-RU',
    subject: 'Совещание',
    body: 'Совещание 12 марта 2026 г. в 14:30, повестка во вложении.',
    expect: { at: L(2026, 3, 12, 14, 30), allDay: false, kind: 'meeting' },
  },
  {
    name: 'ru — срок истекает через 2 дня',
    lang: 'ru',
    locale: 'ru-RU',
    subject: 'Документы',
    body: 'Срок сдачи документов истекает через 2 дня.',
    expect: { at: L(2026, 3, 6), allDay: true, kind: 'deadline' },
  },

  // --- العربية --------------------------------------------------------------
  {
    name: 'ar — 12 مارس 2026 الساعة 14:30',
    lang: 'ar',
    locale: 'ar-SA',
    subject: 'اجتماع الفريق',
    body: 'مرحبا،\nسيعقد الاجتماع يوم 12 مارس 2026 الساعة 14:30 في قاعة الاجتماعات.',
    expect: { at: L(2026, 3, 12, 14, 30), allDay: false, kind: 'meeting' },
  },
  {
    name: 'ar — غدا الساعة 3 مساء',
    lang: 'ar',
    locale: 'ar-SA',
    subject: 'اجتماع',
    body: 'الاجتماع غدا الساعة 3 مساء، يرجى الحضور في الوقت المحدد.',
    expect: { at: L(2026, 3, 5, 15, 0), allDay: false, kind: 'meeting' },
  },
  {
    name: 'ar — يرجى الرد خلال 3 أيام',
    lang: 'ar',
    locale: 'ar-SA',
    subject: 'طلب معلومات',
    body: 'يرجى الرد خلال 3 أيام على هذا الطلب.',
    expect: { at: L(2026, 3, 7), allDay: true, kind: 'deadline' },
  },
  {
    name: 'ar — أرقام هندية في التاريخ',
    lang: 'ar',
    locale: 'ar-SA',
    subject: 'اجتماع',
    body: 'موعد الاجتماع ١٢ مارس ٢٠٢٦ الساعة ١٠:٠٠ صباحا.',
    expect: { at: L(2026, 3, 12, 10, 0), allDay: false, kind: 'meeting' },
  },

  // --- the calendar part, which beats any amount of prose ------------------
  {
    name: 'ics — a real invitation, read from DTSTART',
    lang: 'en',
    subject: 'Invitation: Quarterly review',
    body: 'When: Wednesday, 11 March 2026 09:00\nWhere: Room 4B',
    icsParts: [ICS_TIMED],
    expect: {
      at: Date.UTC(2026, 2, 12, 22, 0),
      allDay: false,
      kind: 'invitation',
      confidence: 'high',
      title: 'Quarterly review',
      location: 'Room 4B',
    },
  },
  {
    name: 'ics — an all-day event is local midnight, not UTC midnight',
    lang: 'en',
    subject: 'Invitation: Team offsite',
    body: 'See attached.',
    icsParts: [ICS_ALLDAY],
    expect: { at: L(2026, 3, 12), allDay: true, kind: 'invitation', confidence: 'high' },
  },
  {
    name: 'ics — the prose in the same mail never overrides it',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '会议邀请',
    body: '会议时间：2026年4月3日 下午2:30（正文写错了，以附件为准）',
    icsParts: [ICS_TIMED],
    expect: { at: Date.UTC(2026, 2, 12, 22, 0), allDay: false, kind: 'invitation' },
  },

  // --- expect nothing: the shapes that read as a date and are not ----------
  {
    name: 'en — version numbers',
    lang: 'en',
    subject: 'Release notes',
    body: `We shipped v2.10.3 today. Version 3.4.2026 of the schema is also live.\n${MS_FOOTER}`,
    expect: null,
  },
  {
    name: 'en — a price and a card number',
    lang: 'en',
    subject: 'Your receipt',
    body: 'Thank you for your purchase. Total: $1,299.00 charged to the card ending 4242.',
    expect: null,
  },
  {
    name: 'en — order and tracking numbers',
    lang: 'en',
    subject: 'Your order has shipped',
    body: 'Order #88401277 has shipped. Tracking number 1Z999AA10123456784.',
    expect: null,
  },
  {
    name: 'en — an IP address',
    lang: 'en',
    subject: 'Security alert',
    body: 'A sign-in attempt from 192.168.1.100 was blocked. If this was you, no action is needed.',
    expect: null,
  },
  {
    name: 'en — a copyright year in the footer',
    lang: 'en',
    subject: 'Welcome',
    body: `Welcome aboard. We are glad to have you.\n${MS_FOOTER}`,
    expect: null,
  },
  {
    name: 'en — "24/7"',
    lang: 'en',
    subject: 'Support',
    body: 'Our support team is available 24/7 for any question you may have.',
    expect: null,
  },
  {
    name: 'en — phone numbers',
    lang: 'en',
    subject: 'Contact us',
    body: 'Call us on +1 (800) 555-0199 or 400-820-8820 any time.',
    expect: null,
  },
  {
    name: 'en — an ISO timestamp inside a forwarded header',
    lang: 'en',
    subject: 'Fwd: notes',
    body:
      'FYI, see below.\n\nFrom: alice@example.com\nSent: Mon, 2 Mar 2026 10:04:11 +0800\nDate: 2026-03-02T10:04:11+08:00\nSubject: notes\n\n> The meeting was fine, thanks.',
    expect: null,
  },
  {
    name: 'en — unsubscribe-footer boilerplate carrying a date',
    lang: 'en',
    subject: 'This week at Example',
    body: `Our roundup of the week.\nYou are receiving this because you subscribed on 3 January 2024.\n${MS_FOOTER}`,
    expect: null,
  },
  {
    name: 'en — a newsletter date with no meeting or deadline word anywhere',
    lang: 'en',
    subject: 'Roadmap update',
    body: `Our roadmap ships on March 12, 2026. ${'A great deal of prose about nothing in particular. '.repeat(12)}`,
    expect: null,
  },
  {
    name: 'en — a date that has already passed',
    lang: 'en',
    subject: 'Meeting notes',
    body: 'Notes from the meeting we held on 12 February 2026 are attached.',
    expect: null,
  },
  {
    name: 'en — an ambiguous numeric date with nothing vouching for it',
    lang: 'en',
    subject: 'Reference',
    body: `Our records show 03/04/2026 against your account. ${'Nothing further is required at this time. '.repeat(10)}`,
    expect: null,
  },
  /* The two below are the cases the strike-out pass exists for, and the only
     thing standing between them and a hit: both carry a meeting word, so the
     keyword-free gate does not save them. Remove `NEGATIVES` and they go red. */
  {
    name: 'en — a ticket number shaped exactly like an ISO date, beside a meeting word',
    lang: 'en',
    subject: 'Meeting notes',
    body: 'The meeting agenda lives in ticket 2026-04-03, see the tracker.',
    expect: null,
  },
  {
    name: 'zh — 会议纪要旁边的工单号',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '会议纪要',
    body: '会议纪要已归档，工单号 2026-04-03，如有疑问请查询系统。',
    expect: null,
  },
  {
    name: 'en — a percentage and a statistic',
    lang: 'en',
    subject: 'Quarterly numbers',
    body: 'Open rate is up 45% and churn is down. Support handled 24/7 volumes without issue.',
    expect: null,
  },
  {
    name: 'zh — 订单号与金额',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '订单通知',
    body: '您的订单号 2026-04-03-88401277 已发货，金额 1299.00 元。',
    expect: null,
  },
  {
    name: 'zh — 版权与客服热线',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '服务通知',
    body: '感谢您的支持。客服热线 400-820-8820，7×24 小时服务。\n版权所有 © 2024 某某公司。退订请回复 TD。',
    expect: null,
  },
  {
    name: 'zh — 有会议二字但没有任何时间',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '会议安排',
    body: '本次会议时间待定，确定后另行通知。',
    expect: null,
  },
  {
    name: 'zh — 地址与邮编',
    lang: 'zh-CN',
    locale: 'zh-CN',
    subject: '发票寄送',
    body: '发票已寄出。地址：深圳市南山区科技南路 12 号 3 栋 405 室，邮编 518057。',
    expect: null,
  },
  {
    name: 'fr — une facture',
    lang: 'fr',
    locale: 'fr-FR',
    subject: 'Votre facture',
    body: 'Facture n° 2026-0403-77 d’un montant de 1 299,00 EUR. Version 2.10.3 du portail.',
    expect: null,
  },
  {
    name: 'es — una versión y un número de pedido',
    lang: 'es',
    locale: 'es-ES',
    subject: 'Actualización',
    body: 'La versión 2.10.3 ya está disponible. Número de pedido 88401277.',
    expect: null,
  },
  {
    name: 'ru — заголовок пересланного письма',
    lang: 'ru',
    locale: 'ru-RU',
    subject: 'Fwd: отчёт',
    body: 'Пересылаю.\n\nОт: ivan@example.ru\nОтправлено: 2 марта 2026 г. 10:04\nТема: отчёт\n\n> спасибо',
    expect: null,
  },
  {
    name: 'ru — номер заказа',
    lang: 'ru',
    locale: 'ru-RU',
    subject: 'Заказ отправлен',
    body: 'Номер заказа 88401277 отправлен. Сумма 1299.00 руб.',
    expect: null,
  },
  {
    name: 'ar — رقم الطلب',
    lang: 'ar',
    locale: 'ar-SA',
    subject: 'تأكيد الطلب',
    body: 'تم شحن طلبك. رقم الطلب 88401277 والمبلغ 1299.00 SAR.',
    expect: null,
  },
  {
    name: 'ar — إصدار جديد بدون أي موعد',
    lang: 'ar',
    locale: 'ar-SA',
    subject: 'تحديث',
    body: 'تم إصدار الإصدار v2.10.3 اليوم مع العديد من التحسينات.',
    expect: null,
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let falsePositives = 0
let misses = 0
let passed = 0
const problems = []
const byLang = new Map()

const stamp = (ms) => `${new Date(ms).toString().slice(0, 24)}`

for (const c of CASES) {
  const lang = byLang.get(c.lang) ?? { total: 0, expectNothing: 0 }
  lang.total++
  if (c.expect === null) lang.expectNothing++
  byLang.set(c.lang, lang)

  const hits = extractDates({
    subject: c.subject ?? '',
    body: c.body ?? '',
    receivedAt: RECEIVED,
    icsParts: c.icsParts,
    locale: c.locale,
  })
  const hit = hits[0] ?? null
  let ok = true

  if (c.expect === null) {
    if (hit) {
      falsePositives++
      ok = false
      problems.push(`FALSE POSITIVE  ${c.name}: expected nothing, got ${stamp(hit.at)} from "${hit.evidence.matched}"`)
    }
  } else if (!hit) {
    misses++
    ok = false
    problems.push(`MISS            ${c.name}: expected ${stamp(c.expect.at)}, got nothing`)
  } else {
    if (hit.at !== c.expect.at) {
      falsePositives++
      ok = false
      problems.push(`WRONG TIME      ${c.name}: expected ${stamp(c.expect.at)}, got ${stamp(hit.at)}`)
    }
    if (hit.allDay !== c.expect.allDay) {
      falsePositives++
      ok = false
      problems.push(`WRONG ALL-DAY   ${c.name}: expected allDay=${c.expect.allDay}`)
    }
    if (hit.kind !== c.expect.kind) {
      falsePositives++
      ok = false
      problems.push(`WRONG KIND      ${c.name}: expected ${c.expect.kind}, got ${hit.kind}`)
    }
    if (c.expect.confidence && hit.confidence !== c.expect.confidence) {
      falsePositives++
      ok = false
      problems.push(`WRONG CONFIDENCE ${c.name}: expected ${c.expect.confidence}, got ${hit.confidence}`)
    }
    if (c.expect.title !== undefined && hit.title !== c.expect.title) {
      falsePositives++
      ok = false
      problems.push(`WRONG TITLE     ${c.name}: expected ${c.expect.title}, got ${hit.title}`)
    }
    if (c.expect.location !== undefined && hit.location !== c.expect.location) {
      falsePositives++
      ok = false
      problems.push(`WRONG LOCATION  ${c.name}: expected ${c.expect.location}, got ${hit.location}`)
    }
    /* Explainability is a promise the card makes, so it is checked like any
       other behaviour: a hit that cannot show what it read is a regression even
       when the instant is right. */
    if (!hit.evidence || !hit.evidence.matched || !hit.evidence.snippet) {
      falsePositives++
      ok = false
      problems.push(`NO EVIDENCE     ${c.name}: ${stamp(hit.at)} was offered with nothing to justify it`)
    }
  }

  if (ok) passed++
}

let extra = 0

/*
 * The anchor. A mail read three days after it arrived must still resolve
 * "tomorrow" to the day after it was *sent* — the same class of bug as using
 * `formatRelative` on a past instant (PROJECT-BRIEF §4), where one function
 * read the clock at the wrong moment and every result was quietly wrong by the
 * reading delay. Nothing else in this file would catch it: every case above
 * happens to be checked at a fixed anchor.
 */
{
  extra++
  const message = { subject: 'Design review', body: 'Let us meet tomorrow at 3 for the design review.' }
  const sentMonday = new Date(2026, 2, 2, 9, 0, 0).getTime()
  const sentThursday = new Date(2026, 2, 5, 9, 0, 0).getTime()
  const a = extractDates({ ...message, receivedAt: sentMonday })[0]
  const b = extractDates({ ...message, receivedAt: sentThursday })[0]
  const okA = a && a.at === L(2026, 3, 3, 15, 0)
  const okB = b && b.at === L(2026, 3, 6, 15, 0)
  if (!okA || !okB) {
    falsePositives++
    problems.push(
      `NOT ANCHORED    "tomorrow" resolved to ${a ? stamp(a.at) : 'nothing'} / ${b ? stamp(b.at) : 'nothing'};` +
        ` expected ${stamp(L(2026, 3, 3, 15, 0))} / ${stamp(L(2026, 3, 6, 15, 0))}`,
    )
  } else {
    passed++
  }
}

/*
 * The documented date-order rule. Each line is a decision that has to keep
 * being made the same way, because the wrong branch is a meeting a month out of
 * place with nothing on screen to suggest anything went wrong.
 */
{
  const order = [
    ['en-US', L(2026, 3, 4), 'medium'],
    ['en-GB', L(2026, 4, 3), 'medium'],
    ['fr-FR', L(2026, 4, 3), 'medium'],
    ['zh-CN', L(2026, 3, 4), 'medium'],
    // Bare `en` is the tag both en-US and en-GB arrive as. Day-first, and said
    // out loud as a low-confidence reading rather than presented as a fact.
    ['en', L(2026, 4, 3), 'low'],
  ]
  for (const [locale, at, confidence] of order) {
    extra++
    const hit = extractDates({
      subject: 'Project meeting',
      body: 'The project meeting is on 03/04/2026.',
      receivedAt: RECEIVED,
      locale,
    })[0]
    if (!hit || hit.at !== at || hit.confidence !== confidence) {
      falsePositives++
      problems.push(
        `WRONG ORDER     03/04/2026 under "${locale}": expected ${stamp(at)} (${confidence}), got ` +
          `${hit ? `${stamp(hit.at)} (${hit.confidence})` : 'nothing'}`,
      )
    } else {
      passed++
    }
  }

  // And the one honest way out of the ambiguity: a weekday only one of the two
  // readings can satisfy.
  extra++
  const settled = extractDates({
    subject: 'Project meeting',
    body: 'The project meeting is on Friday, 03/04/2026.',
    receivedAt: RECEIVED,
    locale: 'en',
  })[0]
  if (!settled || settled.at !== L(2026, 4, 3) || settled.confidence === 'low') {
    falsePositives++
    problems.push(
      `WEEKDAY IGNORED a named weekday should settle 03/04/2026 above low confidence; got ` +
        `${settled ? `${stamp(settled.at)} (${settled.confidence})` : 'nothing'}`,
    )
  } else {
    passed++
  }

  extra++
  if (dateOrderFor('en') !== 'undecided' || dateOrderFor('en-US') !== 'monthFirst' || dateOrderFor('ru-RU') !== 'dayFirst') {
    falsePositives++
    problems.push('WRONG ORDER RULE dateOrderFor no longer matches the documented table')
  } else {
    passed++
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const total = CASES.length + extra
const expectNothing = CASES.filter((c) => c.expect === null).length

for (const line of problems) console.error(`  ${line}`)

const breakdown = [...byLang.entries()]
  .map(([lang, n]) => `${lang} ${n.total}/${n.expectNothing}∅`)
  .join(' · ')

console.log(
  `\ncheck:dates — ${passed}/${total} passed · ${falsePositives} false positive(s) · ${misses} miss(es)` +
    `\n  corpus: ${CASES.length} cases, ${expectNothing} expecting nothing · ${breakdown}`,
)

if (selftest) {
  if (falsePositives === 0) {
    console.error(
      `\nSELFTEST FAILED: the extractor was broken (${BREAKAGES.map((b) => b.name).join('; ')}) and nothing went red.`,
    )
    process.exit(1)
  }
  console.log(`\nSelftest OK — ${falsePositives} failure(s) on the known-bad version.`)
  process.exit(0)
}

/*
 * False positives fail the build. Misses are reported and tolerated: the corpus
 * deliberately contains phrasings at the edge of what prose can carry, and
 * treating "said nothing" as a build break is how a gate gets loosened until it
 * stops meaning anything.
 */
if (falsePositives > 0) {
  console.error('\nFAILED — a wrong date offered as a one-press action is worse than no date.')
  process.exit(1)
}
if (misses > 3) {
  console.error(`\nFAILED — ${misses} misses is more than the three the corpus expects.`)
  process.exit(1)
}
console.log('All clear.')
