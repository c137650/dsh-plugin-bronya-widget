/**
 * 客户端离线自测:用一个假的浏览器环境跑 client.js。
 * 覆盖七种画面(清醒空闲/清醒互动/活动被打扰/吃饭/生气吃饭/睡觉/困困坐起)
 * 以及语音播报时的表现。
 */
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra === undefined ? '' : '  -> ' + extra))
  if (!ok) failures += 1
}

// ---------- 假的 AudioContext ----------
class FakeSource {
  constructor() {
    this.handlers = {}
    this.started = false
    this.buffer = null
  }
  addEventListener(name, fn) {
    ;(this.handlers[name] ||= []).push(fn)
  }
  start() {
    this.started = true
  }
  stop() {
    for (const fn of this.handlers['ended'] || []) fn()
  }
}
class FakeAudioContext {
  createBufferSource() {
    return new FakeSource()
  }
}

// ---------- 假的 DOM ----------
const srcHistory = []
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    setAttribute() {},
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
    },
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
    },
    addEventListener() {},
    removeEventListener() {},
  }
  if (tag === 'img') {
    let value = ''
    Object.defineProperty(el, 'src', {
      get() {
        return value
      },
      set(v) {
        value = v
        srcHistory.push(v)
      },
    })
  }
  return el
}

const documentHandlers = {}
globalThis.document = {
  body: makeElement('body'),
  head: makeElement('head'),
  createElement: makeElement,
  addEventListener(name, fn) {
    ;(documentHandlers[name] ||= []).push(fn)
  },
  removeEventListener() {},
  querySelector() {
    return null
  },
}

// ---------- 假的 navigator.mediaDevices ----------
let micRequests = 0
function fakeStream() {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
  return {
    getTracks() {
      return [track]
    },
  }
}
const fakeMediaDevices = {
  getUserMedia(constraints) {
    micRequests += 1
    return Promise.resolve(fakeStream())
  },
}
// node 的 navigator 是只读 getter,只能改它上面的 mediaDevices
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: fakeMediaDevices,
  configurable: true,
  writable: true,
})

// ---------- 假的 window ----------
const storage = new Map()
globalThis.window = {
  AudioContext: FakeAudioContext,
  innerWidth: 1200,
  innerHeight: 800,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem(k) {
      return storage.has(k) ? storage.get(k) : null
    },
    setItem(k, v) {
      storage.set(k, String(v))
    },
    removeItem(k) {
      storage.delete(k)
    },
  },
}

// ---------- 假的 state 与 fetch ----------
let currentState = { ok: true, phase: 'wake', chat: false, activity: false, recentUser: false, disturb: null, now: Date.now() }
globalThis.fetch = async () => ({ json: async () => ({ ...currentState }) })

// ---------- 加载客户端 bundle ----------
let factory = null
globalThis.window.__ModuleLoader__ = {
  load({ factory: f }) {
    factory = f
  },
}
await import(pathToFileURL('E:/dsh-plugin-bronya-widget/client/client.js').href)
check('bundle 注册成功', typeof factory === 'function')
const mod = factory(() => {
  throw new Error('unexpected require')
})
check('导出 apply', typeof mod.apply === 'function')

const dispose = mod.apply({})
await new Promise((r) => setTimeout(r, 60))

function currentSprite() {
  return srcHistory[srcHistory.length - 1] || ''
}
function spriteName() {
  const s = currentSprite()
  return s.split('/').pop() || ''
}
async function setState(next) {
  currentState = { ok: true, disturb: null, now: Date.now(), ...next }
  await new Promise((r) => setTimeout(r, 1300))
}
function fireInput() {
  for (const fn of documentHandlers['input'] || []) fn({ target: { tagName: 'TEXTAREA' } })
}

console.log('\n[1] 清醒、没人理她 -> 摸鱼打游戏')
await setState({ phase: 'wake', chat: false, activity: false, recentUser: false })
check('game.webp', spriteName() === 'game.webp', spriteName())

console.log('\n[2] 清醒、主会话在生成 -> 敲键盘')
await setState({ phase: 'wake', chat: true, activity: false, recentUser: false })
check('wake.webp', spriteName() === 'wake.webp', spriteName())

console.log('\n[3] 清醒、舰长刚说过话 -> 敲键盘')
await setState({ phase: 'wake', chat: false, activity: false, recentUser: true })
check('wake.webp', spriteName() === 'wake.webp', spriteName())

console.log('\n[4] 清醒、她在跑自主活动、同时在跟你说话 -> 生气敲键盘')
await setState({ phase: 'wake', chat: true, activity: true, recentUser: true })
check('angrytype.webp', spriteName() === 'angrytype.webp', spriteName())

console.log('\n[5] 清醒、活动在跑、但没人理她 -> 敲键盘(在忙自己的)')
await setState({ phase: 'wake', chat: false, activity: true, recentUser: false })
check('wake.webp', spriteName() === 'wake.webp', spriteName())

console.log('\n[6] 吃饭 / 睡觉')
await setState({ phase: 'eat', chat: false, activity: false, recentUser: false })
check('eat.webp', spriteName() === 'eat.webp', spriteName())
await setState({ phase: 'sleep', chat: false, activity: false, recentUser: false })
check('sleep.webp', spriteName() === 'sleep.webp', spriteName())

console.log('\n[7] 吃饭时被搭话 -> 生气;睡觉时被搭话 -> 困困坐起')
await setState({ phase: 'eat', chat: false, activity: false, recentUser: true })
check('angry.webp', spriteName() === 'angry.webp', spriteName())
await setState({ phase: 'sleep', chat: false, activity: false, recentUser: true })
check('wakeup.webp', spriteName() === 'wakeup.webp', spriteName())

console.log('\n[8] 睡觉时正在播报 -> 还是困困坐起')
await setState({ phase: 'sleep', chat: false, activity: false, recentUser: false })
const s1 = new FakeAudioContext().createBufferSource()
s1.start()
await new Promise((r) => setTimeout(r, 20))
check('wakeup.webp', spriteName() === 'wakeup.webp', spriteName())
s1.stop()
await new Promise((r) => setTimeout(r, 20))
check('播完回到 sleep', spriteName() === 'sleep.webp', spriteName())

console.log('\n[9] 清醒空闲时正在播报 -> 拿起耳机说话(voice)')
await setState({ phase: 'wake', chat: false, activity: false, recentUser: false })
const s2 = new FakeAudioContext().createBufferSource()
s2.start()
await new Promise((r) => setTimeout(r, 20))
check('voice.webp', spriteName() === 'voice.webp', spriteName())
s2.stop()
await new Promise((r) => setTimeout(r, 20))
check('播完回到 game', spriteName() === 'game.webp', spriteName())

console.log('\n[10] 舰长在输入框打字 -> 立刻算"在跟你说话"')
await setState({ phase: 'sleep', chat: false, activity: false, recentUser: false })
check('sleep.webp', spriteName() === 'sleep.webp', spriteName())
fireInput()
await new Promise((r) => setTimeout(r, 30))
check('wakeup.webp', spriteName() === 'wakeup.webp', spriteName())

console.log('\n[11] 两路声音叠加:停一路不该提前结束')
await new Promise((r) => setTimeout(r, 2700))   // 等打字的宽限期过去
await setState({ phase: 'sleep', chat: false, activity: false, recentUser: false })
const a = new FakeAudioContext().createBufferSource()
const b = new FakeAudioContext().createBufferSource()
a.start()
b.start()
await new Promise((r) => setTimeout(r, 20))
check('wakeup.webp', spriteName() === 'wakeup.webp', spriteName())
a.stop()
await new Promise((r) => setTimeout(r, 20))
check('还剩一路,仍然 wakeup', spriteName() === 'wakeup.webp', spriteName())
b.stop()
await new Promise((r) => setTimeout(r, 20))
check('全停后回到 sleep', spriteName() === 'sleep.webp', spriteName())

console.log('\n[12] 清醒时麦克风开着 -> 拿起耳机说话')
await setState({ phase: 'wake', chat: false, activity: false, recentUser: false })
check('先确认是 game', spriteName() === 'game.webp', spriteName())
const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
await new Promise((r) => setTimeout(r, 30))
check('voice.webp', spriteName() === 'voice.webp', spriteName())

console.log('\n[13] 麦克风关上 -> 回到原来的画面')
stream.getTracks()[0].stop()
await new Promise((r) => setTimeout(r, 30))
check('game.webp', spriteName() === 'game.webp', spriteName())

console.log('\n[14] 麦克风开着时正在播报 -> 还是 voice')
const stream2 = await navigator.mediaDevices.getUserMedia({ audio: true })
const s3 = new FakeAudioContext().createBufferSource()
s3.start()
await new Promise((r) => setTimeout(r, 30))
check('voice.webp', spriteName() === 'voice.webp', spriteName())
s3.stop()
stream2.getTracks()[0].stop()
await new Promise((r) => setTimeout(r, 30))

console.log('\n[15] 睡觉/吃饭时,麦克风开着也不换成 voice')
await setState({ phase: 'sleep', chat: false, activity: false, recentUser: false })
const stream3 = await navigator.mediaDevices.getUserMedia({ audio: true })
await new Promise((r) => setTimeout(r, 30))
check('sleep 时仍是 sleep', spriteName() === 'sleep.webp', spriteName())
stream3.getTracks()[0].stop()
await new Promise((r) => setTimeout(r, 30))

console.log('\n[16] 语音模块的开关不算数(开关开着不等于正在说话)')
await setState({ phase: 'wake', chat: false, activity: false, recentUser: false })
storage.set('s2s.voice.mic', '1')
storage.set('s2s.voice.enabled', '1')
await new Promise((r) => setTimeout(r, 1300))
check('两个开关都写着 1,仍然是 game', spriteName() === 'game.webp', spriteName())
storage.set('s2s.voice.mic', '0')
storage.set('s2s.voice.enabled', '0')

console.log('\n[17] 音频源没收到 ended 也不会一直挂着(时长兜底)')
const s4 = new FakeAudioContext().createBufferSource()
s4.buffer = { duration: 0.05 }
s4.start()
await new Promise((r) => setTimeout(r, 30))
check('先切到 voice', spriteName() === 'voice.webp', spriteName())
await new Promise((r) => setTimeout(r, 3200))
check('兜底到点后自己退回 game', spriteName() === 'game.webp', spriteName())

dispose()
console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
