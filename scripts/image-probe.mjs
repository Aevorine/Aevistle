/**
 * Drive the picture pipeline end to end in the running app.
 *
 * Paste an image into the compose body → a thumbnail must appear → clicking it
 * must open the full-screen viewer → Escape must close it. Every step asserts
 * on the DOM, because "no error in the console" is exactly the shape of the
 * bug this feature exists to fix.
 */
const PORT = Number(process.env.CDP_PORT ?? 9445)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('No page target.')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const r = pending.get(m.id)
  if (r) {
    pending.delete(m.id)
    r(m)
  }
})
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((r) => pending.set(id, r))
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const ex = res.result?.exceptionDetails
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex))
  return res.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = false
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`)
  if (!ok) failed = true
}

console.log('\n--- picture pipeline ---')

const bridge = await evaluate(`JSON.stringify({
  hasApi: typeof window.aevistle === 'object',
  keys: window.aevistle ? Object.keys(window.aevistle).filter(k => /attach|read/i.test(k)) : [],
})`)
console.log('  bridge:', bridge)

// 1. paste an image into the body
const pasted = await evaluate(`(async () => {
  const ta = document.querySelector('.textarea--body')
  if (!ta) return 'no textarea'
  const canvas = document.createElement('canvas')
  canvas.width = 480; canvas.height = 300
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#3355cc'; ctx.fillRect(0, 0, 480, 300)
  ctx.fillStyle = '#ffffff'; ctx.font = '40px serif'
  ctx.fillText('AEVISTLE', 90, 165)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const file = new File([blob], 'probe-image.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  ta.focus()
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  return 'dispatched'
})()`)
check('paste dispatched', pasted === 'dispatched', String(pasted))

await sleep(1500)

const afterPaste = await evaluate(`JSON.stringify({
  bodyText: (document.querySelector('.textarea--body')?.value ?? '').slice(0, 80),
  strip: document.querySelectorAll('.imagestrip__item').length,
  thumbSrc: (document.querySelector('.imagestrip__thumb')?.getAttribute('src') ?? '').slice(0, 30),
  attachRows: document.querySelectorAll('.attachment').length,
  attachThumbs: document.querySelectorAll('.attachment__icon--thumb').length,
})`)
console.log('  after paste:', afterPaste)
const p = JSON.parse(afterPaste)
check('cid tag written into the body', /<img src="cid:/.test(p.bodyText), p.bodyText)
check('attachment row created', p.attachRows >= 1)
check('thumbnail strip shows the picture', p.strip >= 1)
check('thumbnail is real image data', p.thumbSrc.startsWith('data:image/'), p.thumbSrc)
check('attachment row shows a thumbnail too', p.attachThumbs >= 1)

// 2. click the thumbnail → viewer opens
await evaluate(`document.querySelector('.imagestrip__item')?.click(), true`)
await sleep(600)
const opened = await evaluate(`JSON.stringify({
  lightbox: !!document.querySelector('.lightbox'),
  img: (document.querySelector('.lightbox__image')?.getAttribute('src') ?? '').slice(0, 22),
  buttons: document.querySelectorAll('.lightbox__btn').length,
  transform: document.querySelector('.lightbox__image')?.style.transform ?? '',
  rect: (() => { const r = document.querySelector('.lightbox__image')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null })(),
})`)
console.log('  viewer:', opened)
const o = JSON.parse(opened)
check('viewer opened', o.lightbox)
check('viewer is showing the picture', o.img.startsWith('data:image/'))
check('viewer has its control set', o.buttons >= 8, `${o.buttons} buttons`)
check('picture actually has size on screen', Array.isArray(o.rect) && o.rect[0] > 50 && o.rect[1] > 50, JSON.stringify(o.rect))

// 3. the optional controls do something measurable
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })), true`)
await sleep(250)
const rotated = await evaluate(`document.querySelector('.lightbox__image')?.style.transform ?? ''`)
check('R rotates', /rotate\(90deg\)/.test(rotated), rotated)

await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })), true`)
await sleep(250)
const actual = await evaluate(`document.querySelector('.lightbox__image')?.style.transform ?? ''`)
check('1 goes to actual size', /scale\(1,\s*1\)/.test(actual), actual)

await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true })), true`)
await sleep(250)
const info = await evaluate(`JSON.stringify({
  panel: !!document.querySelector('.lightbox__info'),
  values: [...document.querySelectorAll('.lightbox__infoval')].map(e => e.textContent),
})`)
console.log('  info:', info)
check('I shows the details panel with real values', /[0-9]+ × [0-9]+/.test(info), info)

// 4. Escape closes the viewer and nothing else
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
await sleep(400)
const closed = await evaluate(`JSON.stringify({
  lightbox: !!document.querySelector('.lightbox'),
  stillOnCompose: !!document.querySelector('.view--compose'),
  strip: document.querySelectorAll('.imagestrip__item').length,
})`)
console.log('  after Esc:', closed)
const c = JSON.parse(closed)
check('Escape closes the viewer', !c.lightbox)
check('Escape did not close anything else', c.stillOnCompose && c.strip >= 1)

ws.close()
process.exit(failed ? 1 : 0)
