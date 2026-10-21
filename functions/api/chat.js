// POST /api/chat { pass, mode:'fast'|'expert', history:[{role,text}], prompt, files:[{name,mimeType,dataBase64|text}]}
// Streams the model's reply as plain text (deltas). Pre-stream errors are JSON {error}.
// Server-side call to Gemini streamGenerateContent with inline file data.
// API key stays in Cloudflare env (GEMINI_API_KEY or GOOGLE_API_KEY), never in the browser.

const MODES = {
  fast: { model: 'gemini-3.8-flash', thinkingLevel: 'low' },
  expert: { model: 'gemini-3.1-pro-preview', thinkingLevel: 'high' },
};
const MAX_TOTAL_B64 = 28 * 1024 * 1024; // ~21MB raw, keeps request under Gemini inline limits

export async function onRequestPost(context) {
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

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + cfg.model + ':streamGenerateContent?alt=sse';
  const callGemini = (withThinking) => {
    const payload = { contents };
    if (withThinking) payload.generationConfig = { thinkingConfig: { thinkingLevel: cfg.thinkingLevel } };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
    });
  };

  let resp;
  try { resp = await callGemini(true); } catch (e) { return err(502, '连不上 Gemini API：' + e.message); }
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const msg = (data && data.error && data.error.message) || ('Gemini API HTTP ' + resp.status);
    if (resp.status === 400) {
      // thinkingConfig may not be accepted for this model; retry once without it.
      try {
        const r2 = await callGemini(false);
        if (r2.ok) resp = r2;
        else return err(502, msg);
      } catch { return err(502, msg); }
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
      'X-Wy-Model': cfg.model,
    },
  });
}

function err(status, message) {
  return Response.json({ error: message }, { status });
}
