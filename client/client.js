// dsh-plugin-bronya-widget — client bundle (hand-written ModuleLoader form).
// 右下角一个 <img>,播的是宿主端发出来的动图(assets/<state>.webp)。可拖拽,位置记在 localStorage。
window.__ModuleLoader__.load({ id: 'dsh-plugin-bronya-widget', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports

  var POLL_MS = 1200
  var SIZE = 84
  var MARGIN = 12
  var POS_KEY = 'dsh-plugin-bronya-widget:pos'
  /** 舰长停下打字之后再算"正在被打扰"多久(毫秒)。 */
  var TYPING_GRACE_MS = 2500

  var typingUntil = 0
  /** 正在发声的音频源数量(语音播报走 AudioContext,外面看不见)。 */
  var activeAudio = 0
  var audioPatched = false
  /** 正在开着的麦克风数量(语音插件的持续监听)。 */
  var activeMics = 0
  var micPatched = false

  function isTyping(el) {
    if (!el) return false
    var tag = String(el.tagName || '').toLowerCase()
    return tag === 'textarea' || tag === 'input' || el.isContentEditable === true
  }

  /** 语音模块自己的开关(它写在 localStorage 里,只读不改)。 */
  function voiceFlag(key) {
    try {
      var raw = window.localStorage.getItem(key)
      return raw === '1'
    } catch (e) {
      return false
    }
  }

  /**
   * 语音交互是不是正在进行:
   *   - 麦克风真的开着(浏览器里拿到了音频流);
   *   - 语音模块的麦克风开关打开着;
   *   - 语音模块的播报开关打开着;
   *   - 此刻正在播报。
   * 任何一个成立就算语音交互中。
   */
  function voiceInteractionActive() {
    if (activeMics > 0) return true
    if (activeAudio > 0) return true
    if (voiceFlag('s2s.voice.mic')) return true
    if (voiceFlag('s2s.voice.enabled')) return true
    return false
  }

  /** 这份 getUserMedia 的约束里要不要音频。 */
  function wantsAudio(constraints) {
    if (!constraints) return false
    if (Array.isArray(constraints)) {
      for (var i = 0; i < constraints.length; i++) {
        if (wantsAudio(constraints[i])) return true
      }
      return false
    }
    if (constraints.audio === undefined) return false
    return constraints.audio !== false
  }

  /**
   * 盯住麦克风。
   * 语音插件的麦克风是"点一次开始持续监听",浏览器侧的信号就是
   * getUserMedia(audio) —— 开了就 +1,轨道 stop() 就 -1。
   * 摄像头那条路走的是本地 bridge,不经过 getUserMedia,所以不会混进来。
   */
  function trackMic(onChange) {
    if (micPatched) return
    try {
      var md = navigator.mediaDevices
      if (!md || typeof md.getUserMedia !== 'function') return
      var orig = md.getUserMedia.bind(md)
      md.getUserMedia = function (constraints) {
        var audio = wantsAudio(constraints)
        return orig(constraints).then(function (stream) {
          if (!audio) return stream
          activeMics += 1
          onChange()
          var released = false
          var tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : []
          for (var i = 0; i < tracks.length; i++) {
            (function (track) {
              var origStop = track.stop.bind(track)
              track.stop = function () {
                if (!released) {
                  released = true
                  activeMics = Math.max(0, activeMics - 1)
                  onChange()
                }
                return origStop()
              }
            })(tracks[i])
          }
          return stream
        })
      }
      micPatched = true
    } catch (e) {
      /* 环境不支持就算了 */
    }
  }

  /**
   * 盯住 AudioContext 播放。
   * 语音插件的播报是用 AudioBufferSourceNode 播的,没有 <audio> 元素、
   * 也没有对外暴露 speaking,所以包一层 createBufferSource().start() 来数
   * "现在有几路声音在响"。结束用 ended 事件退回,不改对方任何行为。
   */
  function trackAudio(onChange) {
    if (audioPatched) return
    try {
      var AC = window.AudioContext || window.webkitAudioContext
      if (!AC || !AC.prototype || typeof AC.prototype.createBufferSource !== 'function') return
      var proto = AC.prototype
      var origCreate = proto.createBufferSource
      proto.createBufferSource = function () {
        var node = origCreate.apply(this, arguments)
        try {
          var origStart = node.start
          var counted = false
          node.start = function () {
            if (!counted) {
              counted = true
              activeAudio += 1
              try {
                node.addEventListener('ended', function () {
                  activeAudio = Math.max(0, activeAudio - 1)
                  onChange()
                })
              } catch (e) {
                /* 老浏览器没有 addEventListener 就算了 */
              }
            }
            var result = origStart.apply(this, arguments)
            onChange()
            return result
          }
        } catch (e) {
          /* 包不上就退回原样 */
        }
        return node
      }
      audioPatched = true
    } catch (e) {
      /* 环境不支持就算了 */
    }
  }

  function stateOf(data) {
    if (!data) return 'wake'
    var phase = data.phase
    // "正在跟你互动":主会话在生成 / 舰长刚说过话 / 舰长正在打字 / 正在播报
    var engaged = !!(data.chat || data.recentUser) || Date.now() < typingUntil || activeAudio > 0

    if (phase === 'sleep') return engaged ? 'wakeup' : 'sleep'
    if (phase === 'eat') return engaged ? 'angry' : 'eat'

    // 清醒:语音交互中(麦克风开着 / 播报开着 / 正在播报)-> 拿起耳机说话
    if (voiceInteractionActive()) return 'voice'
    // 她自己在跑自主活动的时候被打扰 -> 生气敲键盘;
    // 没事干又没人理她 -> 摸鱼打游戏;其余时候敲键盘。
    if (engaged && data.activity) return 'angrytype'
    if (!engaged && !data.activity) return 'game'
    return 'wake'
  }

  function spriteUrl(name) {
    return '/bronya-widget/sprite/' + name + '.webp'
  }

  function loadPos() {
    try {
      var raw = window.localStorage.getItem(POS_KEY)
      if (!raw) return null
      var p = JSON.parse(raw)
      if (p && typeof p.left === 'number' && typeof p.top === 'number') return p
    } catch (e) {
      /* 读不到就当没拖过 */
    }
    return null
  }

  function savePos(p) {
    try {
      window.localStorage.setItem(POS_KEY, JSON.stringify(p))
    } catch (e) {
      /* 存不了就算了 */
    }
  }

  function clamp(p) {
    var maxLeft = Math.max(0, window.innerWidth - SIZE)
    var maxTop = Math.max(0, window.innerHeight - SIZE)
    return {
      left: Math.max(0, Math.min(maxLeft, Math.round(p.left))),
      top: Math.max(0, Math.min(maxTop, Math.round(p.top))),
    }
  }

  function bottomRight() {
    return clamp({
      left: window.innerWidth - SIZE - MARGIN,
      top: window.innerHeight - SIZE - MARGIN,
    })
  }

  exports.apply = function apply() {
    if (typeof document === 'undefined') return
    var stopped = false
    var wrap = null
    var img = null
    var current = ''
    var pos = null
    var dragged = false
    var dragging = false
    var dragOffset = { x: 0, y: 0 }
    var lastData = null

    function place(p) {
      pos = clamp(p)
      wrap.style.left = pos.left + 'px'
      wrap.style.top = pos.top + 'px'
    }

    function onDown(e) {
      if (e.button !== 0) return
      var rect = wrap.getBoundingClientRect()
      dragged = true
      dragging = true
      dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      wrap.style.cursor = 'grabbing'
      e.preventDefault()
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onUp, true)
    }

    function onMove(e) {
      if (!dragging) return
      place({ left: e.clientX - dragOffset.x, top: e.clientY - dragOffset.y })
    }

    function onUp() {
      if (!dragging) return
      dragging = false
      wrap.style.cursor = 'grab'
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      if (pos) savePos(pos)
    }

    function onResize() {
      if (!wrap) return
      place(dragged && pos ? pos : bottomRight())
    }

    function mount() {
      if (stopped || wrap) return
      if (!document.body) {
        window.setTimeout(mount, 300)
        return
      }
      wrap = document.createElement('div')
      wrap.setAttribute('data-plugin', 'dsh-plugin-bronya-widget')
      wrap.setAttribute('data-draggable', 'true')
      wrap.style.cssText = [
        'position:fixed',
        'width:' + SIZE + 'px',
        'height:' + SIZE + 'px',
        'z-index:40',
        'pointer-events:auto',
        'cursor:grab',
        'user-select:none',
        '-webkit-user-drag:none',
        'filter:drop-shadow(0 4px 8px rgba(0,0,0,.3))',
        'opacity:0',
        'transition:opacity .6s ease',
      ].join(';')

      img = document.createElement('img')
      img.alt = ''
      img.draggable = false
      img.style.cssText = [
        'width:100%',
        'height:100%',
        'display:block',
        'object-fit:contain',
        'pointer-events:none',
      ].join(';')
      img.addEventListener('load', function () {
        wrap.style.opacity = '1'
      })
      img.addEventListener('error', function () {
        /* 换状态时偶发的图片错误不影响下一轮 */
      })
      wrap.appendChild(img)
      wrap.addEventListener('mousedown', onDown)
      wrap.addEventListener('dblclick', function () {
        dragged = false
        place(bottomRight())
        savePos(pos)
      })
      document.body.appendChild(wrap)

      var saved = loadPos()
      if (saved) {
        dragged = true
        place(saved)
      } else {
        place(bottomRight())
      }
      window.addEventListener('resize', onResize)
      document.addEventListener('input', onInput, true)
      trackAudio(function () {
        if (lastData) setState(stateOf(lastData))
      })
      trackMic(function () {
        if (lastData) setState(stateOf(lastData))
      })

      setState('wake')
      poll()
    }

    function onInput(e) {
      if (!isTyping(e.target)) return
      var wasIdle = Date.now() >= typingUntil
      typingUntil = Date.now() + TYPING_GRACE_MS
      if (wasIdle && lastData) setState(stateOf(lastData))
    }

    function setState(name) {
      if (!img || name === current) return
      current = name
      img.src = spriteUrl(name)
    }

    async function poll() {
      if (stopped) return
      try {
        var res = await fetch('/bronya-widget/state', { cache: 'no-store' })
        var data = await res.json()
        if (data && data.ok) {
          lastData = data
          setState(stateOf(data))
        }
      } catch (e) {
        /* 网络抖动就保持当前状态 */
      }
      window.setTimeout(poll, POLL_MS)
    }

    mount()

    return function dispose() {
      stopped = true
      window.removeEventListener('resize', onResize)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap)
      wrap = null
      img = null
    }
  }

  exports.name = 'dsh-plugin-bronya-widget'
  exports.inject = []
  return module.exports
}})
