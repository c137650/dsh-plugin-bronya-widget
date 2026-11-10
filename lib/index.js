/**
 * dsh-plugin-bronya-widget — host entry.
 *
 * 在 DSH 主会话右下角挂一个像素风格的布洛妮娅小形象,形象随她的作息变化:
 * 清醒时敲键盘(在跟你说话)、闲着摸鱼打游戏、吃饭、睡觉;
 * 被打扰时(吃饭->生气,睡觉->困困坐起)换表情;她自己在跑自主活动的时候
 * 被搭话,则是"生气敲键盘"。
 *
 * 作息的唯一来源是 dsh-plugin-life 的心跳落盘文件 status.json(phase +
 * today.segments),本插件不复制那套作息算法,只读、只翻译。
 * "活动正在执行"靠会话前缀判断:life 插件的后台活动跑在 life-* 的会话里。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-bronya-widget'
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 动图资产的目录(插件自带,随包发布)。 */
const SPRITE_DIR = path.join(HERE, '..', 'assets')
/** 允许被当作精灵发出去的状态名,顺带挡掉路径穿越。 */
const SPRITE_STATES = new Set([
  'wake', 'angrytype', 'game', 'voice', 'eat', 'angry', 'sleep', 'wakeup',
])

/** 被打扰的表情持续多久(毫秒)。 */
const DISTURB_MS = 18000
/** status.json 超过这个时间没更新,就按作息表自己推当前阶段。 */
const STATUS_STALE_MS = 15 * 60_000
/** life 插件的后台活动跑在 life-* 会话里;life-detail-* 是展开细节的对话,算正常聊天。 */
const LIFE_PREFIX = 'life-'
const LIFE_DETAIL_PREFIX = 'life-detail-'
/** 这些 source.kind 不是舰长开口,不算打扰。 */
const NON_HUMAN_SOURCES = new Set([
  'runtime-context',
  'model-selection',
  'system-prompt',
  'tool-registry',
  'plugin:dsh-plugin-masterprompt',
  'plugin:dsh-plugin-life',
])

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

/** 这个会话是不是 life 插件的后台自主活动。 */
function isActivitySession(sid) {
  return typeof sid === 'string' && sid.startsWith(LIFE_PREFIX) && !sid.startsWith(LIFE_DETAIL_PREFIX)
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

export function apply(ctx) {
  /**
   * 最近一次"被打扰":{kind, sid, at}。
   * 什么时候结束不看固定时长,看那个会话是不是还在忙 —— 舰长还在打字、
   * 或者布洛妮娅还在生成,就一直保持被打扰的样子。
   */
  let disturbance = null
  /** 每个会话是否正处在一轮对话里(turn/start 与 turn/end 之间)。 */
  const busy = new Map()
  /** 舰长最后一次开口的时间(任何阶段都记,清醒时也要用)。 */
  let lastUserAt = 0

  function readLifeStatus() {
    try {
      const file = path.join(dshHome(), 'dsh-plugin-life', 'status.json')
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      return parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** 按 today.segments 推算此刻的阶段(跨午夜用 life 的同一套折返规则)。 */
  function phaseFromSegments(status, at) {
    const segments = status && status.today && Array.isArray(status.today.segments) ? status.today.segments : undefined
    if (!segments || !segments.length) return undefined
    let wakeMinutes
    for (const seg of segments) {
      if (seg && seg.state === 'wake' && Number.isFinite(seg.startMin)) {
        wakeMinutes = seg.startMin
        break
      }
    }
    if (!Number.isFinite(wakeMinutes)) return undefined
    const day = new Date(at)
    day.setHours(0, 0, 0, 0)
    let minutes = ((at - day.getTime()) / 60_000) % 1440
    if (minutes < wakeMinutes) minutes += 1440
    for (const seg of segments) {
      if (!seg || !Number.isFinite(seg.startMin) || !Number.isFinite(seg.endMin)) continue
      if (minutes >= seg.startMin && minutes < seg.endMin) return seg.state
    }
    return undefined
  }

  function phaseNow() {
    const status = readLifeStatus()
    const at = Date.now()
    const updated = status && typeof status.updatedAt === 'string' ? Date.parse(status.updatedAt) : 0
    const fresh = Number.isFinite(updated) && at - updated < STATUS_STALE_MS
    if (fresh && typeof status.phase === 'string' && status.phase) return { phase: status.phase, status, fresh }
    const derived = phaseFromSegments(status, at)
    if (derived) return { phase: derived, status, fresh: false }
    if (status && typeof status.phase === 'string' && status.phase) return { phase: status.phase, status, fresh: false }
    return { phase: undefined, status, fresh: false }
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (!event) return
        const sid = session && typeof session.id === 'string' ? session.id : ''

        // 会话忙不忙:一轮对话从 turn/start 开始、turn/end 结束
        if (event.type === 'turn/start') {
          if (sid) busy.set(sid, true)
          return
        }
        if (event.type === 'turn/end') {
          if (sid) busy.set(sid, false)
          return
        }
        if (event.type !== 'user/message') return

        const message = event.data
        const kind = message && message.source && typeof message.source.kind === 'string' ? message.source.kind : ''
        if (kind && (NON_HUMAN_SOURCES.has(kind) || kind.startsWith('plugin:'))) return
        // 舰长开口:任何阶段都记一笔 —— 清醒时也要靠它判断"正在跟你说话"
        lastUserAt = Date.now()
        const { phase } = phaseNow()
        if (phase !== 'eat' && phase !== 'sleep') return
        disturbance = { kind: phase, sid, at: lastUserAt }
      } catch {
        /* 记状态失败不能影响对话 */
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, 'bronya-widget: disturbance watch')

  /**
   * 现在有几件事在发生:
   * - chat:主会话正在生成(不含 life 插件的后台活动)
   * - activity:life 插件的后台自主活动正在执行
   * - recentUser:舰长刚说过话(宽限期内)
   */
  function activityState() {
    let chat = false
    let activity = false
    for (const [sid, isBusy] of busy) {
      if (isBusy !== true) continue
      if (isActivitySession(sid)) activity = true
      else chat = true
    }
    return { chat, activity }
  }

  ctx.effect(() => {
    const route = ctx.webServer.register({
      kind: 'exact',
      path: '/bronya-widget/state',
      handler: (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405)
            res.end()
            return
          }
          const now = Date.now()
          const { phase, status, fresh } = phaseNow()
          const { chat, activity } = activityState()
          let active = null
          if (disturbance) {
            const isBusy = disturbance.sid ? busy.get(disturbance.sid) === true : false
            const withinGrace = now - disturbance.at < DISTURB_MS
            if (isBusy || withinGrace) {
              active = { kind: disturbance.kind, since: disturbance.at, busy: isBusy }
            } else {
              disturbance = null
            }
          }
          sendJson(res, 200, {
            ok: true,
            phase: phase ?? null,
            fresh,
            chat,
            activity,
            recentUser: now - lastUserAt < DISTURB_MS,
            life: status
              ? {
                  updatedAt: status.updatedAt ?? null,
                  state: status.state ?? null,
                  nextActivityAt: status.nextActivityAt ?? null,
                }
              : null,
            disturb: active,
            now,
          })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    })
    return () => {
      if (typeof route === 'function') route()
    }
  }, 'bronya-widget: http route')

  ctx.effect(() => {
    const route = ctx.webServer.register({
      kind: 'prefix',
      path: '/bronya-widget/sprite',
      handler: (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405)
            res.end()
            return
          }
          const url = new URL(req.url || '/', 'http://x')
          const name = String(url.pathname).slice('/bronya-widget/sprite/'.length).replace(/\.webp$/i, '')
          if (!SPRITE_STATES.has(name)) {
            res.writeHead(404)
            res.end()
            return
          }
          const bytes = readFileSync(path.join(SPRITE_DIR, name + '.webp'))
          res.writeHead(200, {
            'content-type': 'image/webp',
            'content-length': bytes.byteLength,
            'cache-control': 'no-cache',
          })
          res.end(bytes)
        } catch {
          res.writeHead(404)
          res.end()
        }
      },
    })
    return () => {
      if (typeof route === 'function') route()
    }
  }, 'bronya-widget: sprite route')
}
