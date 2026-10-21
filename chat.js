// POST /api/chat { pass, model, history:[{role,text}], prompt, files:[{name,mimeType,dataBase64|text}]}
// Server-side call to Gemini generateContent with inline file data.
// API key stays in Cloudflare env (GEMINI_API_KEY or GOOGLE_API_KEY), never in the browser.

const ALLOWED_MODELS = [
'gemini-3.8-flash',
'gemini-3.1-pro-preview',
'gemini-2.5-flash',
'gemini-2.5-pro',
];
const MAX_TOTAL_B64 = 28 * 1024 * 1024; // ~21MB raw, keeps request under Gemini inline limits

export async function onRequestPost(context) {
const env = context.env || {};
let body;
try { body = await context.request.json();} catch { return err(400, '请求不是有效 JSON');}

const sitePass = env.SITE_PASSWORD || env.CODE || '';
if (sitePass && body.pass!== sitePass) return err(401, '访问密码不正确');

const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
if (!apiKey) return err(500, '服务端还没有配置 GEMINI_API_KEY');

const model = ALLOWED_MODELS.includes(body.model)? body.model: (env.GEMINI_MODEL || 'gemini-3.8-flash');

// Build contents: history as text turns, then current turn with files first.
const contents = [];
for (const m of (Array.isArray(body.history)? body.history.slice(-20): [])) {
if (!m || typeof m.text!== 'string' ||!m.text) continue;
contents.push({ role: m.role === 'model'? 'model': 'user', parts: [{ text: m.text.slice(0, 30000)}]});
}
const parts = [];
let totalB64 = 0;
for (const f of (Array.isArray(body.files)? body.files.slice(0, 10): [])) {
if (!f) continue;
if (f.dataBase64) {
totalB64 += f.dataBase64.length;
if (totalB64 > MAX_TOTAL_B64) return err(413, '附件总大小超过上限（约 20MB），请减少或拆分文件');
parts.push({ inlineData: { mimeType: f.mimeType || 'application/octet-stream', data: f.dataBase64}});
} else if (typeof f.text === 'string') {
parts.push({ text: '\n' + f.text.slice(0, 200000)});
}
}
parts.push({ text: String(body.prompt || '请分析附件文件的内容。').slice(0, 30000)});
contents.push({ role: 'user', parts});

const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
let resp;
try {
resp = await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey},
body: JSON.stringify({ contents}),
});
} catch (e) {
return err(502, '连不上 Gemini API：' + e.message);
}
const data = await resp.json().catch(() => ({}));
if (!resp.ok) {
const msg = (data && data.error && data.error.message) || ('Gemini API HTTP ' + resp.status);
return err(resp.status === 404? 404: 502, msg);
}
const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
.map((p) => p.text || '').join('').trim();
if (!text) {
const fb = data.promptFeedback && data.promptFeedback.blockReason;
return err(502, fb? '请求被 Gemini 拦截：' + fb: 'Gemini 没有返回文字内容');
}
return Response.json({ text, model});
}

function err(status, message) {
return Response.json({ error: message}, { status});
}
