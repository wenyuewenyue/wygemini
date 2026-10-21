// GET /api/config -> { needCode, model }
export async function onRequestGet(context) {
  const env = context.env || {};
  return Response.json({
    needCode: !!(env.SITE_PASSWORD || env.CODE),
    model: env.GEMINI_MODEL || 'gemini-3.8-flash',
  });
}
