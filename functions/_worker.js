export default {
  async fetch(request, env, context) {
    // 仅允许 GET 请求
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;

    // 优先读取 CF CDN 缓存
    let cachedRes = await cache.match(cacheKey);
    if (cachedRes) {
      return cachedRes;
    }

    // 根路径 / 指向 index.html
    let key = url.pathname === "/" ? "index.html" : url.pathname.slice(1);

    // 从 R2 获取文件
    const object = await env.R2_BUCKET.get(key);
    if (!object) {
      return new Response("Not Found", { status: 404 });
    }

    // 组装响应头
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    // max-age 浏览器缓存 10分钟  s-maxage CF CDN 缓存1天
    headers.set("Cache-Control", "public, max-age=600, s-maxage=86400");

    const response = new Response(object.body, { headers });

    // 异步写入 CF CDN 缓存
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  }
};
