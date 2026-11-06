// mini-agent 后端：把大模型“接进来” + 演示“工具”与“循环”两层。
// 零依赖：只用 Node 内置模块（http/fs/path），无需 npm install。
// 设计目标：没填 API Key 也能跑（mock 模式），填上 Key 就接真实大模型。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ---- 极简 .env 加载（替代 dotenv，避免额外依赖）----
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#') || !line.trim()) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.LLM_API_KEY || '';
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

// ---- 第 3 层：工具（Tools）----
// Agent 的能力清单。这里放一个最简单的工具：获取当前时间。
// 真实项目里，这里会是“读日志/跑命令/查数据库”等。
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前的日期和时间（当用户问“现在几点”时使用）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: '计算数学表达式，支持加减乘除和括号。当用户需要精确计算时使用。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '要计算的表达式，例如 (1234 * 5678) / 2',
          },
        },
        required: ['expression'],
      },
    },
  },
];

function get_current_time() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// 白名单：只允许数字、小数点、+ - * / ( ) 和空格
const EXPR_WHITELIST = /^[0-9.+\-*/() ]+$/;

// 不用 eval / new Function，手写一个递归下降解析器：
// 语法只有 expr := term (('+'|'-') term)*，term := factor (('*'|'/') factor)*，
// factor := '(' expr ')' | 一元 +- | 数字
function calculate(expression) {
  const s = String(expression ?? '').trim();
  if (!s || !EXPR_WHITELIST.test(s)) throw new Error('表达式非法');

  let i = 0;
  const skip = () => { while (i < s.length && s[i] === ' ') i++; };

  function parseNumber() {
    skip();
    const start = i;
    while (i < s.length && (s[i] >= '0' && s[i] <= '9' || s[i] === '.')) i++;
    if (start === i) throw new Error('表达式非法');
    const n = Number(s.slice(start, i));
    if (!Number.isFinite(n)) throw new Error('表达式非法');
    return n;
  }

  function parseFactor() {
    skip();
    if (s[i] === '(') {
      i++;
      const v = parseExpr();
      skip();
      if (s[i] !== ')') throw new Error('表达式非法');
      i++;
      return v;
    }
    if (s[i] === '-') { i++; return -parseFactor(); }
    if (s[i] === '+') { i++; return parseFactor(); }
    return parseNumber();
  }

  function parseTerm() {
    let v = parseFactor();
    for (;;) {
      skip();
      const op = s[i];
      if (op !== '*' && op !== '/') break;
      i++;
      const r = parseFactor();
      if (op === '/') {
        if (r === 0) throw new Error('除数不能为 0');
        v /= r;
      } else {
        v *= r;
      }
    }
    return v;
  }

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      skip();
      const op = s[i];
      if (op !== '+' && op !== '-') break;
      i++;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  const result = parseExpr();
  skip();
  if (i !== s.length) throw new Error('表达式非法'); // 还有没解析完的残余
  return result;
}

// 调用大模型的一次封装（第 1 层：接入 LLM）。Node 18+ 自带全局 fetch。
async function callLLM(messages, withTools = false) {
  const body = { model: MODEL, messages };
  if (withTools) body.tools = TOOLS;
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// 流式调用大模型（SSE）。返回一个 async generator：
//   - yield { type: 'text', text }   文本增量
//   - yield { type: 'end', toolCalls } 流结束，toolCalls 是累积好的工具调用数组
async function* callLLMStream(messages, withTools = false) {
  const body = { model: MODEL, messages, stream: true };
  if (withTools) body.tools = TOOLS;

  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM 流式请求失败: ${resp.status} ${text}`);
  }

  const decoder = new TextDecoder('utf-8');
  const toolCallMap = {}; // index -> { id, name, arguments }
  let buffer = '';

  for await (const chunk of resp.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let nlIdx;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
      buffer = buffer.slice(nlIdx + 1);
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        const toolCalls = Object.keys(toolCallMap)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => toolCallMap[k]);
        yield { type: 'end', toolCalls };
        return;
      }

      let json;
      try { json = JSON.parse(payload); } catch { continue; }

      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: 'text', text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallMap[idx]) toolCallMap[idx] = { id: '', name: '', arguments: '' };
          if (tc.id) toolCallMap[idx].id = tc.id;
          if (tc.function?.name) toolCallMap[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  // 流自然结束但没收到 [DONE]，也把已累积的工具调用返回
  const toolCalls = Object.keys(toolCallMap)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => toolCallMap[k]);
  yield { type: 'end', toolCalls };
}

const server = http.createServer(async (req, res) => {
  // 允许跨域（万一以后前端单独部署也能调）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let messages = [];
    try { messages = JSON.parse(raw).messages || []; } catch { /* ignore */ }

    let reply;
    if (!API_KEY) {
      // ---- mock 兜底：没配 Key 时，让 UI 照样能跑、能演示“工具”概念 ----
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      reply = `[Mock 模式 · 未配置 LLM_API_KEY]\n你问了：「${lastUser?.content || ''}」\n当前时间：${get_current_time()}\n（把 .env 里的 LLM_API_KEY 填上，就会变成真实大模型回复）`;
    } else {
      try {
        // ---- 第 4 层：编排循环（“想→做→再想”，最多 MAX_STEPS 轮）----
        const MAX_STEPS = 5;
        let lastContent = '';
        let step = 0;

        while (step < MAX_STEPS) {
          step++;

          // 每一轮都要带工具清单（第二个参数 true），否则模型拿不到工具
          const data = await callLLM(messages, true);
          const msg = data.choices?.[0]?.message;
          if (!msg) { res.writeHead(502); return res.end(JSON.stringify({ error: 'LLM 返回异常', detail: data })); }

          lastContent = msg.content || '';

          // 这一轮决定调用工具：执行完把结果回灌进 messages，进入下一轮
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            messages.push(msg);

            for (const tc of msg.tool_calls) {
              const name = tc.function.name;
              let output;
              if (name === 'get_current_time') {
                output = get_current_time();
              } else if (name === 'calculate') {
                // 模型给的参数是 JSON 字符串，可能不合法，解析失败也要兜住
                let args = {};
                try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
                try {
                  output = String(calculate(args.expression));
                } catch (e) {
                  output = e.message || '表达式非法';
                }
              } else {
                output = '未知工具';
              }

              console.log(`[工具] ${name}`, tc.function.arguments);
              messages.push({ role: 'tool', tool_call_id: tc.id, content: output });
            }

            continue;
          }

          // 这一轮不再调工具，说明模型给出了最终回答
          reply = msg.content || '';
          break;
        }

        // 跑满 MAX_STEPS 还没收敛：用最后一轮的 content 兜底
        if (reply === undefined) {
          reply = `已达到工具调用上限（${MAX_STEPS} 轮），当前结果：${lastContent || '（无结果）'}`;
        }
        // 任何情况下都不给前端返回空字符串
        if (!reply) reply = '（模型未返回内容）';
      } catch (e) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: String(e) }));
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ role: 'assistant', content: reply }));
  }

  // ---- 流式对话：SSE 逐字返回，支持多轮工具调用 ----
  if (req.method === 'POST' && req.url === '/api/chat/stream') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let messages = [];
    try { messages = JSON.parse(raw).messages || []; } catch { /* ignore */ }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // mock 模式：没 Key 时直接流式回一段兜底文本
    if (!API_KEY) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const mockText = `[Mock 模式 · 未配置 LLM_API_KEY]\n你问了：「${lastUser?.content || ''}」\n当前时间：${get_current_time()}\n（把 .env 里的 LLM_API_KEY 填上，就会变成真实大模型回复）`;
      res.write(`data: ${JSON.stringify({ type: 'delta', text: mockText })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      return res.end();
    }

    try {
      const MAX_STEPS = 5;
      let roundContent = ''; // 当前这一轮累积的文本
      let step = 0;
      let finished = false;

      while (step < MAX_STEPS) {
        step++;
        roundContent = '';
        let toolCalls = [];

        // 每轮都带工具清单（第二个参数 true）
        for await (const evt of callLLMStream(messages, true)) {
          if (evt.type === 'text') {
            roundContent += evt.text;
            res.write(`data: ${JSON.stringify({ type: 'delta', text: evt.text })}\n\n`);
          } else if (evt.type === 'end') {
            toolCalls = evt.toolCalls;
          }
        }

        // 这一轮调了工具：把 assistant 消息和工具结果回灌，进入下一轮
        if (toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: roundContent || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });

          for (const tc of toolCalls) {
            const name = tc.name;
            let output;
            if (name === 'get_current_time') {
              output = get_current_time();
            } else if (name === 'calculate') {
              let args = {};
              try { args = JSON.parse(tc.arguments || '{}'); } catch { /* ignore */ }
              try {
                output = String(calculate(args.expression));
              } catch (e) {
                output = e.message || '表达式非法';
              }
            } else {
              output = '未知工具';
            }

            console.log(`[工具] ${name}`, tc.arguments);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: output });
          }

          continue;
        }

        // 没调工具，说明模型给了最终回答
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        finished = true;
        break;
      }

      if (!finished) {
        const msg = `已达到工具调用上限（${MAX_STEPS} 轮），当前结果：${roundContent || '（无结果）'}`;
        res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
    }

    return res.end();
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`mini-agent API 已启动：http://localhost:${PORT}  (${API_KEY ? '真实大模型' : 'mock 模式'})`);
});
