// POST /api/chat { pass, mode:'lite'|'fast'|'expert', history:[{role,text}], prompt, files:[{name,mimeType,dataBase64|text}]}
// Streams the model's reply as plain text (deltas). Pre-stream errors are JSON {error}.
// Server-side call to Gemini streamGenerateContent with inline file data.
// API key stays in Cloudflare env (GEMINI_API_KEY or GOOGLE_API_KEY), never in the browser.

const MODES = {
  lite: { model: 'gemini-3.5-flash-lite', thinkingLevel: 'minimal' },
  fast: { model: 'gemini-3.8-flash', thinkingLevel: 'low' },
  expert: { model: 'gemini-3.8-flash', thinkingLevel: 'high' },
};
const FALLBACK_MODE = 'lite'; // used automatically when the 3.8-flash free quota (429) is hit
const MAX_TOTAL_B64 = 28 * 1024 * 1024; // ~21MB raw, keeps request under Gemini inline limits

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return err(500, '函数异常：' + ((e && e.message) || String(e)));
  }
}

async function handlePost(context) {
  const env = context.env || {};
  let body;
  try { body = await context.request.json(); } catch { return err(400, '请求不是有效 JSON'); }

  const sitePass = env.SITE_PASSWORD || env.CODE || '';
  if (sitePass && body.pass !== sitePass) return err(401, '访问密码不正确');

  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  if (!apiKey) return err(500, '服务端还没有配置 GEMINI_API_KEY');

  const mode = MODES[body.mode] ? body.mode : 'fast';
  const cfg = MODES[mode];

  // Build contents: history as text turns, then current turn with files first.
  const contents = [];
  for (const m of (Array.isArray(body.history) ? body.history.slice(-20) : [])) {
    if (!m || typeof m.text !== 'string' || !m.text) continue;
    contents.push({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text.slice(0, 30000) }] });
  }
  const parts = [];
  let totalB64 = 0;
  for (const f of (Array.isArray(body.files) ? body.files.slice(0, 10) : [])) {
    if (!f) continue;
    if (f.dataBase64) {
      totalB64 += f.dataBase64.length;
      if (totalB64 > MAX_TOTAL_B64) return err(413, '附件总大小超过上限（约 20MB），请减少或拆分文件');
      parts.push({ inlineData: { mimeType: f.mimeType || 'application/octet-stream', data: f.dataBase64 } });
    } else if (typeof f.text === 'string') {
      parts.push({ text: '\n' + f.text.slice(0, 200000) });
    }
  }
  parts.push({ text: String(body.prompt || '请分析附件文件的内容。').slice(0, 30000) });
  contents.push({ role: 'user', parts });

  const callGemini = (useCfg, withThinking) => {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + useCfg.model + ':streamGenerateContent?alt=sse';
    const payload = { contents };
    if (withThinking) payload.generationConfig = { thinkingConfig: { thinkingLevel: useCfg.thinkingLevel } };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
    });
  };

  let resp;
  let usedCfg = cfg;
  let fellBack = false;
  try { resp = await callGemini(cfg, true); } catch (e) { return err(502, '连不上 Gemini API：' + e.message); }
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    let msg = '';
    try { const d = JSON.parse(raw); msg = (d && d.error && d.error.message) || ''; } catch {}
    if (!msg) msg = ('Gemini API HTTP ' + resp.status + (raw ? '：' + raw.slice(0, 300) : ''));
    if (resp.status === 429 && mode !== FALLBACK_MODE) {
      // Free quota for this model is used up for today: fall back to Flash-Lite,
      // whose free tier has its own, much larger daily allowance.
      try {
        const fb = MODES[FALLBACK_MODE];
        const r3 = await callGemini(fb, true);
        if (r3.ok) { resp = r3; usedCfg = fb; fellBack = true; }
        else {
          const raw3 = await r3.text().catch(() => '');
          return err(502, msg + '（自动切换 Lite 也失败：HTTP ' + r3.status + (raw3 ? '：' + raw3.slice(0, 300) : '') + '）');
        }
      } catch (e) { return err(502, msg + '（自动切换 Lite 出错：' + e.message + '）'); }
    } else if (resp.status === 400) {
      // thinkingConfig may not be accepted for this model; retry once without it.
      try {
        const r2 = await callGemini(cfg, false);
        if (r2.ok) resp = r2;
        else {
          const raw2 = await r2.text().catch(() => '');
          return err(502, msg + '（去掉 thinking 重试也失败：HTTP ' + r2.status + (raw2 ? '：' + raw2.slice(0, 300) : '') + '）');
        }
      } catch (e) { return err(502, msg + '（去掉 thinking 重试出错：' + e.message + '）'); }
    } else {
      return err(resp.status === 404 ? 404 : 502, msg);
    }
  }

  // Pipe SSE deltas out as plain text. Thought parts (reasoning) are not answer text.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let sentAny = false;
  const stream = new ReadableStream({
    async start(controller) {
      if (fellBack) controller.enqueue(encoder.encode('（原模型的今日免费额度已用完，已自动切换到 Flash-Lite 回答）\n\n'));
      const reader = resp.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
              const chunk = JSON.parse(jsonStr);
              const cparts = (chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts) || [];
              const text = cparts.filter((p) => !p.thought).map((p) => p.text || '').join('');
              if (text) { sentAny = true; controller.enqueue(encoder.encode(text)); }
            } catch {}
          }
        }
        if (!sentAny) controller.enqueue(encoder.encode('（Gemini 没有返回文字内容）'));
      } catch (e) {
        controller.enqueue(encoder.encode('\n[出错了：' + e.message + ']'));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Wy-Mode': mode,
      'X-Wy-Model': usedCfg.model,
    },
  });
}

function err(status, message) {
  return Response.json({ error: message }, { status });
}
