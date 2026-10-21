// WyFile frontend: chat + file attachments for Gemini analysis.
// Native files (PDF/image/audio/video) are sent as base64 inline data via our
// own Pages Function. Text files are read as text. Office files (docx/xlsx/pptx)
// are unzipped in the browser and their text is extracted, then sent as text.

const $ = (id) => document.getElementById(id);
const chatEl = $('chat'), inputEl = $('input'), trayEl = $('fileTray');
const MAX_FILE = 20 * 1024 * 1024; // 20MB per file (inline path)
const MAX_TEXT = 200000; // chars kept per extracted-text file

let history = []; // {role:'user'|'model', text}
let attachments = []; // {name, kind:'inline'|'text', mimeType, data}
let sending = false;

const NATIVE = [
  'application/pdf',
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
  'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
  'video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi', 'video/x-flv',
  'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
];
const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'log', 'xml', 'html', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'css', 'yml', 'yaml', 'toml', 'sh', 'sql'];
const OOXML = { docx: 'word/document.xml', xlsx: null, pptx: null };

function ext(name) { return (name.split('.').pop() || '').toLowerCase(); }
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.ceil(n / 1024) + 'KB'; }

function renderEmpty() {
  if (!history.length) chatEl.innerHTML = '<div class="empty">上传 PDF、图片、Word、Excel 等文件，再提问即可分析。<br>也可以直接聊天，不带文件。</div>';
}
function addMsg(role, text, files) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'model' ? 'model' : role);
  const b = document.createElement('div'); b.className = 'bubble';
  if (files && files.length) {
    const f = document.createElement('div'); f.className = 'files';
    f.textContent = '📎 ' + files.join('、'); b.appendChild(f);
  }
  b.appendChild(document.createTextNode(text));
  div.appendChild(b); chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return b;
}
function renderTray() {
  trayEl.innerHTML = '';
  trayEl.classList.toggle('hidden', !attachments.length);
  for (const [i, a] of attachments.entries()) {
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.textContent = '📎 ' + a.name + ' (' + (a.kind === 'text' ? '文字' : fmtSize(a.size || 0)) + ') ';
    const x = document.createElement('button'); x.textContent = '✕'; x.title = '移除';
    x.onclick = () => { attachments.splice(i, 1); renderTray(); };
    chip.appendChild(x); trayEl.appendChild(chip);
  }
}

// ---------- ZIP (for docx/xlsx/pptx) ----------
async function unzipEntries(buf) {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/Office 文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.slice(off + 46, off + 46 + nameLen));
    entries[name] = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  async function read(name) {
    const e = entries[name]; if (!e) return null;
    const lo = e.localOff;
    const nl = dv.getUint16(lo + 26, true), el = dv.getUint16(lo + 28, true);
    const raw = u8.slice(lo + 30 + nl + el, lo + 30 + nl + el + e.compSize);
    if (e.method === 0) return new TextDecoder().decode(raw);
    const ds = new DecompressionStream('deflate-raw');
    const out = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
    return new TextDecoder().decode(out);
  }
  return { entries, read };
}
function xmlText(xml) {
  return xml
    .replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (m) => m + '\n')
    .replace(/<a:p[ >][\s\S]*?<\/a:p>/g, (m) => m + '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
async function extractOffice(file) {
  const buf = await file.arrayBuffer();
  const zip = await unzipEntries(buf);
  const e = ext(file.name);
  if (e === 'docx') {
    const xml = await zip.read('word/document.xml');
    if (!xml) throw new Error('docx 里找不到正文');
    return xmlText(xml);
  }
  if (e === 'pptx') {
    const names = Object.keys(zip.entries).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
    const parts = [];
    for (const n of names) parts.push('--- ' + n.split('/').pop() + ' ---\n' + xmlText(await zip.read(n)));
    return parts.join('\n');
  }
  // xlsx
  const ssXml = await zip.read('xl/sharedStrings.xml');
  const strings = [];
  if (ssXml) for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(xmlText(m[1]));
  const sheets = Object.keys(zip.entries).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  const out = [];
  for (const n of sheets) {
    const xml = await zip.read(n);
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const tM = /(?:^|\s)t="([^"]*)"/.exec(cm[1]);
        const vm = /<v>([\s\S]*?)<\/v>/.exec(cm[2]);
        const im = vm ? null : /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cm[2]);
        let v = vm ? vm[1] : (im ? im[1] : '');
        if (tM && tM[1] === 's' && v !== '') v = strings[parseInt(v, 10)] ?? v;
        cells.push(xmlText(v));
      }
      rows.push(cells.join('\t'));
    }
    out.push('--- ' + n.split('/').pop() + ' ---\n' + rows.join('\n'));
  }
  return out.join('\n');
}

// ---------- file intake ----------
function readAsBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
async function handleFiles(fileList) {
  for (const file of fileList) {
    try {
      if (file.size > MAX_FILE) { addMsg('error', `文件 ${file.name} 超过 20MB 上限，已跳过。更大的文件需要走 Files API，后续版本再加。`); continue; }
      const e = ext(file.name);
      if (NATIVE.includes(file.type) || (e === 'pdf' && !file.type)) {
        attachments.push({ name: file.name, kind: 'inline', mimeType: file.type || 'application/pdf', data: await readAsBase64(file), size: file.size });
      } else if (e in OOXML) {
        const text = (await extractOffice(file)).slice(0, MAX_TEXT);
        attachments.push({ name: file.name, kind: 'text', mimeType: 'text/plain', data: text, size: file.size });
      } else if (TEXT_EXT.includes(e) || file.type.startsWith('text/')) {
        const text = (await file.text()).slice(0, MAX_TEXT);
        attachments.push({ name: file.name, kind: 'text', mimeType: 'text/plain', data: text, size: file.size });
      } else {
        addMsg('error', `暂不支持 ${file.name} 这种格式。可以转成 PDF、图片、TXT/CSV，或 Word/Excel/PPT 再传。`);
        continue;
      }
    } catch (err) {
      addMsg('error', `读取 ${file.name} 失败：${err.message}`);
    }
  }
  renderTray();
}

// ---------- chat ----------
async function send() {
  if (sending) return;
  const prompt = inputEl.value.trim();
  if (!prompt && !attachments.length) return;
  const pass = localStorage.getItem('wyfile_pass') || '';
  const model = $('model').value;
  const filesNow = attachments.slice();
  addMsg('user', prompt || '（请分析附件文件）', filesNow.map((f) => f.name));
  inputEl.value = ''; inputEl.style.height = 'auto';
  sending = true; $('sendBtn').disabled = true;
  const thinking = addMsg('model', '思考中…');
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pass, model,
        history: history.slice(-20),
        prompt: prompt || '请分析附件文件的内容。',
        files: filesNow.map((f) => f.kind === 'inline'
          ? { name: f.name, mimeType: f.mimeType, dataBase64: f.data }
          : { name: f.name, mimeType: 'text/plain', text: f.data }),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    thinking.parentElement.remove();
    if (!resp.ok) {
      if (resp.status === 401) openPass();
      addMsg('error', '出错了：' + (data.error || ('HTTP ' + resp.status)));
      return;
    }
    addMsg('model', data.text || '（没有返回文字）');
    history.push({ role: 'user', text: prompt || '（分析附件：' + filesNow.map((f) => f.name).join('、') + '）' });
    history.push({ role: 'model', text: data.text });
  } catch (err) {
    thinking.parentElement.remove();
    addMsg('error', '网络错误：' + err.message);
  } finally {
    sending = false; $('sendBtn').disabled = false;
  }
}

// ---------- password ----------
function openPass() { $('passModal').classList.remove('hidden'); $('passInput').focus(); }
$('passSave').onclick = () => {
  localStorage.setItem('wyfile_pass', $('passInput').value.trim());
  $('passModal').classList.add('hidden');
};
$('passBtn').onclick = openPass;

// ---------- wiring ----------
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
$('sendBtn').onclick = send;
$('clearBtn').onclick = () => { history = []; attachments = []; chatEl.innerHTML = ''; renderTray(); renderEmpty(); };
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
$('model').value = localStorage.getItem('wyfile_model') || 'gemini-3.8-flash';
$('model').onchange = () => localStorage.setItem('wyfile_model', $('model').value);

renderEmpty();
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (c.needCode && !localStorage.getItem('wyfile_pass')) openPass();
}).catch(() => {});
