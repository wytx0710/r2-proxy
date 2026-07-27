export default {
  async fetch(request, env, context) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;

    // 先读 CDN 缓存
    let cachedRes = await cache.match(cacheKey);
    if (cachedRes) return cachedRes;

    // 访问 / 自动返回 index.html
    let key = url.pathname === "/" ? "index.html" : url.pathname.slice(1);

    // 1. 先尝试从 R2 获取文件
    let object = await env.R2_BUCKET.get(key);

    // 2. 如果 R2 没有 → 镜像回源（核心功能）
    if (!object) {
      try {
        // ====================== 在这里填你的源站 ======================
        const originUrl = "http://s3.liuyue.net" + url.pathname;
        // ==============================================================

        const originResponse = await fetch(originUrl);
        if (!originResponse.ok) throw new Error("源站获取失败");

        // 把文件保存回 R2
        const arrayBuffer = await originResponse.arrayBuffer();
        await env.R2_BUCKET.put(key, arrayBuffer, {
          httpMetadata: originResponse.headers,
        });

        // 重新从 R2 读取
        object = await env.R2_BUCKET.get(key);
      } catch (err) {
        return new Response("Not Found", { status: 404 });
      }
    }

    // 正常返回文件
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=600, s-maxage=86400");

    const response = new Response(object.body, { headers });
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  },
};
