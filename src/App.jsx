import { useState, useEffect, useRef } from 'react'

const WEATHER_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074&current=temperature_2m,relative_humidity_2m&timezone=Asia/Shanghai'

// 把回复里的 **文字** 渲染成粗体，避免气泡里出现裸露的星号
function renderMarkdown(text) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part
  )
}

export default function App() {
  // messages: 对话历史，[{ role: 'user'|'assistant', content: string }]
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  // 天气卡片：weather 存数据，weatherStatus 存状态，reloadKey 用来触发重试
  const [weather, setWeather] = useState(null)
  const [weatherStatus, setWeatherStatus] = useState('loading') // 'loading' | 'success' | 'error'
  const [reloadKey, setReloadKey] = useState(0)

  // 拖拽：offset 记录卡片相对原位偏移，dragRef 记录本次拖拽起点（不触发重渲染）
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(null)

  function startDrag(e) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origin: offset }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onDrag(e) {
    if (!dragRef.current) return
    const { startX, startY, origin } = dragRef.current
    setOffset({
      x: origin.x + e.clientX - startX,
      y: origin.y + e.clientY - startY,
    })
  }

  function endDrag(e) {
    dragRef.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  useEffect(() => {
    let cancelled = false
    setWeatherStatus('loading')

    fetch(WEATHER_URL)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setWeather({
          temperature: data.current.temperature_2m,
          humidity: data.current.relative_humidity_2m,
        })
        setWeatherStatus('success')
      })
      .catch(() => {
        if (cancelled) return
        setWeatherStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [reloadKey])

  // 把「最后一条消息」的内容替换成 acc（流式时反复调用）
  function paintLast(acc) {
    setMessages((prev) => {
      const copy = [...prev]
      copy[copy.length - 1] = { role: 'assistant', content: acc }
      return copy
    })
  }

  async function send() {
    const text = input.trim()
    if (!text || loading) return

    // 1) 用户消息 + 一条空的 assistant 占位（占位后续会被逐字填满）
    const history = [...messages, { role: 'user', content: text }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setInput('')
    setLoading(true)

    let acc = ''
    try {
      // 2) 打流式端点（注意：不再是 /api/chat）
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      })
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)

      // 3) 逐块读取
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // stream: true 必须加：汉字是多字节，块边界可能切在字符中间
        buffer += decoder.decode(value, { stream: true })

        // SSE 事件以空行分隔
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)

          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue
            let evt
            try {
              evt = JSON.parse(line.slice(5).trim())
            } catch {
              continue
            }

            if (evt.type === 'delta' && evt.text) {
              acc += evt.text
              paintLast(acc)
            } else if (evt.type === 'error') {
              acc += (acc ? '\n\n' : '') + '⚠️ ' + (evt.message || '出错了')
              paintLast(acc)
            }
          }
        }
      }

      if (!acc) paintLast('（没有收到内容）')
    } catch (e) {
      paintLast(acc ? acc + '\n\n出错了：' + String(e) : '出错了：' + String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="chat">
      <h1>我的第一个 AI Agent</h1>
      <p className="hint">在下方输入问题，回车或点“发送”。试试问：“现在几点了？”</p>

      <section
        style={{
          marginTop: 18,
          border: '1px solid #2a2f3a',
          borderRadius: 12,
          background: '#14171d',
          padding: 16,
          position: 'relative',
          zIndex: 10,
          transform: `translate(${offset.x}px, ${offset.y}px)`,
          userSelect: 'none',
        }}
      >
        <h2
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{
            fontSize: 16,
            margin: '0 0 8px',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        >
          北京实时天气
          <span style={{ fontSize: 12, fontWeight: 400, color: '#5f636b', marginLeft: 8 }}>
            按住标题拖动
          </span>
        </h2>
        {weatherStatus === 'loading' && <p className="hint">正在获取天气…</p>}
        {weatherStatus === 'error' && (
          <>
            <p className="hint">获取天气失败</p>
            <button onClick={() => setReloadKey((k) => k + 1)}>重试</button>
          </>
        )}
        {weatherStatus === 'success' && weather && (
          <p className="hint">
            温度：{weather.temperature} °C ｜ 湿度：{weather.humidity} %
          </p>
        )}
      </section>

      <div className="box">
        {messages.length === 0 && <div className="empty">还没有对话，发一条试试 👇</div>}
        {messages.map((m, i) => (
          <div key={i} className={'row ' + m.role}>
            <div className="who">{m.role === 'user' ? '你' : 'Agent'}</div>
            <div className="bubble">{renderMarkdown(m.content)}</div>
          </div>
        ))}
        {loading && <div className="row assistant"><div className="who">Agent</div><div className="bubble">思考中…</div></div>}
      </div>

      <div className="inputbar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="说点什么…"
        />
        <button onClick={send} disabled={loading}>发送</button>
      </div>
    </main>
  )
}
