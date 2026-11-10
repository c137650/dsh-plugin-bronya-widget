/**
 * bronya-widget 宿主端离线自测。
 * 覆盖:阶段读取、过期回退、打扰判定、会话忙时保持打扰、精灵路由。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(path.join(tmpdir(), 'bw-home-'))
process.env.DSH_HOME = home
const lifeDir = path.join(home, 'dsh-plugin-life')
mkdirSync(lifeDir, { recursive: true })

const { apply } = await import(pathToFileURL('E:/dsh-plugin-bronya-widget/lib/index.js').href)

const listeners = {}
const routes = {}
const ctx = {
  logger: { info() {}, warn() {} },
  on(name, fn) {
    ;(listeners[name] ||= []).push(fn)
    return () => {}
  },
  webServer: {
    register(def) {
      routes[def.path] = def
      return () => {}
    },
  },
  effect(fn) {
    fn()
    return () => {}
  },
  get() {
    return undefined
  },
}

apply(ctx)

function writeStatus(patch) {
  writeFileSync(path.join(lifeDir, 'status.json'), JSON.stringify(patch), 'utf8')
}

async function getState() {
  const res = { status: 0, body: '' }
  res.writeHead = (s) => {
    res.status = s
  }
  res.end = (b) => {
    if (b) res.body = String(b)
  }
  await routes['/bronya-widget/state'].handler({ method: 'GET', url: '/bronya-widget/state', headers: {} }, res)
  return JSON.parse(res.body)
}

const SID = 'session-x'
function emit(event) {
  for (const fn of listeners['session/event'] || []) fn({ id: SID }, event)
}

function userSays(kind) {
  emit({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind } } })
}

let failures = 0
function check(label, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra === undefined ? '' : '  -> ' + extra))
  if (!ok) failures += 1
}

const iso = new Date().toISOString()

console.log('\n[1] 新鲜 status.json:直接读 phase')
writeStatus({ state: 'loaded', phase: 'eat', updatedAt: iso })
let st = await getState()
check('phase = eat', st.phase === 'eat', st.phase)
check('fresh = true', st.fresh === true, String(st.fresh))

console.log('\n[2] 吃饭时舰长开口 -> 生气')
userSays('human')
st = await getState()
check('disturb = eat', !!(st.disturb && st.disturb.kind === 'eat'), JSON.stringify(st.disturb))
check('尚未忙', st.disturb && st.disturb.busy === false, JSON.stringify(st.disturb))

console.log('\n[3] 一轮对话开始 -> 打扰保持(busy)')
emit({ type: 'turn/start', data: { turn: 1 } })
st = await getState()
check('busy = true', st.disturb && st.disturb.busy === true, JSON.stringify(st.disturb))

console.log('\n[4] 一轮对话结束 -> 不再 busy(但还在宽限期内)')
emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
st = await getState()
check('busy = false', st.disturb && st.disturb.busy === false, JSON.stringify(st.disturb))
check('宽限期内仍然显示', !!st.disturb, JSON.stringify(st.disturb))

console.log('\n[5] 插件自己的消息不算打扰')
writeStatus({ state: 'loaded', phase: 'wake', updatedAt: iso })
await getState()
userSays('plugin:dsh-plugin-masterprompt')
st = await getState()
check('没有产生新的 sleep 打扰', !st.disturb || st.disturb.kind !== 'sleep', JSON.stringify(st.disturb))

console.log('\n[6] 睡觉时舰长开口 -> 困困坐起')
writeStatus({ state: 'loaded', phase: 'sleep', updatedAt: iso })
userSays('human')
st = await getState()
check('disturb = sleep', !!(st.disturb && st.disturb.kind === 'sleep'), JSON.stringify(st.disturb))

console.log('\n[7] status.json 过期:按今天的作息表推算')
const stale = new Date(Date.now() - 40 * 60_000).toISOString()
const nowMin = Math.floor((Date.now() - new Date(new Date().setHours(0, 0, 0, 0)).getTime()) / 60_000)
const segs = [
  { state: 'sleep', from: '22:00', to: '07:00', startMin: -120, endMin: 420 },
  { state: 'wake', from: '07:00', to: '12:00', startMin: 420, endMin: 720 },
  { state: 'eat', from: '12:00', to: '12:40', startMin: 720, endMin: 760 },
  { state: 'wake', from: '12:40', to: '23:00', startMin: 760, endMin: 1380 },
]
writeStatus({ state: 'loaded', phase: 'wake', updatedAt: stale, today: { segments: segs } })
st = await getState()
const expected = nowMin >= 420 && nowMin < 720 ? 'wake' : nowMin >= 720 && nowMin < 760 ? 'eat' : nowMin >= 760 ? 'wake' : 'sleep'
check('按 segments 推出的阶段正确', st.phase === expected, 'nowMin=' + nowMin + ' got=' + st.phase + ' want=' + expected)
check('fresh = false', st.fresh === false, String(st.fresh))

console.log('\n[8] 没有 life 插件:不炸')
rmSync(path.join(lifeDir, 'status.json'), { force: true })
st = await getState()
check('phase 为 null', st.phase === null, String(st.phase))
check('life 为 null', st.life === null, JSON.stringify(st.life))

console.log('\n[9] 精灵路由')
async function getSprite(urlPath) {
  const res = { status: 0, headers: {}, bytes: 0 }
  res.writeHead = (s, h) => {
    res.status = s
    res.headers = h || {}
  }
  res.end = (b) => {
    if (b) res.bytes = b.length
  }
  await routes['/bronya-widget/sprite'].handler({ method: 'GET', url: urlPath, headers: {} }, res)
  return res
}
for (const name of ['wake', 'angrytype', 'game', 'voice', 'eat', 'angry', 'sleep', 'wakeup']) {
  const r = await getSprite('/bronya-widget/sprite/' + name + '.webp')
  check(name + '.webp 可取', r.status === 200 && r.bytes > 1000, r.status + ' / ' + r.bytes)
}
const bad = await getSprite('/bronya-widget/sprite/../../state.json')
check('路径穿越被挡', bad.status === 404, String(bad.status))

console.log('\n[10] 活动检测:life-* 会话在跑 = 活动执行中')
function emitAs(sid, event) {
  for (const fn of listeners['session/event'] || []) fn({ id: sid }, event)
}
writeStatus({ state: 'loaded', phase: 'wake', updatedAt: new Date().toISOString() })
// 先让主会话安静
emitAs('session-main', { type: 'turn/start', data: { turn: 1 } })
emitAs('session-main', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
st = await getState()
check('主会话空闲时 chat=false', st.chat === false, String(st.chat))
check('主会话空闲时 activity=false', st.activity === false, String(st.activity))

// life 的后台活动跑起来了
emitAs('life-abc-123', { type: 'turn/start', data: { turn: 1 } })
st = await getState()
check('activity = true', st.activity === true, String(st.activity))
check('chat 仍然是 false(活动不算聊天)', st.chat === false, String(st.chat))

// 活动结束
emitAs('life-abc-123', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
st = await getState()
check('活动结束 activity = false', st.activity === false, String(st.activity))

console.log('\n[11] life-detail-* 是正常对话,算 chat 不算 activity')
emitAs('life-detail-xyz', { type: 'turn/start', data: { turn: 1 } })
st = await getState()
check('chat = true', st.chat === true, String(st.chat))
check('activity = false', st.activity === false, String(st.activity))
emitAs('life-detail-xyz', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

console.log('\n[12] recentUser:舰长开口后一段时间内为 true')
writeStatus({ state: 'loaded', phase: 'wake', updatedAt: new Date().toISOString() })
st = await getState()
check('刚说完话 recentUser = true', st.recentUser === true, String(st.recentUser))

rmSync(home, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
