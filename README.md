# WyFile · Gemini 文件分析（Cloudflare Pages 轻量版）

一个静态页面 + 两个 Pages Functions，无构建步骤。浏览器只连本站域名，
Gemini API 由服务端（Cloudflare）调用，API Key 不进浏览器。

## 功能
- 纯文字聊天（多轮，保留最近 20 条）
- 文件分析（附件保留到手动移除，可连续追问）：
  - Gemini 原生：PDF、图片（png/jpg/webp/heic/heif）、音频、视频 — 以 inlineData 发送
  - 浏览器提取文字：TXT/MD/CSV/JSON/代码文件；Word(docx)/Excel(xlsx)/PPT(pptx) 在浏览器解压提取文字
- 访问密码门（可选）：设置 `SITE_PASSWORD`（或 `CODE`）后，首页会要求输入密码
- 模型可选，默认 `gemini-3.8-flash`

## 限制（V1）
- 单文件 ≤ 20MB，附件总计约 20MB（inline 上限内）。更大的文件需走 Gemini Files API，后续可加。
- Office 文件只提取文字，不含其中的图片/图表；扫描版 PDF 请直接传 PDF 本身（原生分析带 OCR 效果）。

## 环境变量（Cloudflare Pages 项目设置）
| 名称 | 必填 | 说明 |
|---|---|---|
| `GEMINI_API_KEY`（或 `GOOGLE_API_KEY`） | ✔ | Google AI Studio 的 Gemini API Key，设为 Secret |
| `SITE_PASSWORD`（或 `CODE`） | 建议 | 访问密码，设为 Secret |
| `GEMINI_MODEL` | ✘ | 默认模型，缺省 `gemini-3.8-flash` |

## 部署（Cloudflare Pages，Git 连接）
- Framework preset: None
- Build command: （留空）
- Build output directory: `/`
- 然后在项目 Settings → Environment variables 里加上面变量，重新部署生效。

## 本地结构
- `index.html` / `style.css` / `app.js` — 前端
- `functions/api/config.js` — GET /api/config
- `functions/api/chat.js` — POST /api/chat（服务端调 Gemini）
