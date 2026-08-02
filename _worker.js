export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    // 处理OPTIONS跨域预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders()
      });
    }

    // 仅允许GET请求
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;

    // 优先读取Cloudflare边缘缓存
    let cachedRes = await cache.match(cacheKey);
    if (cachedRes) return cachedRes;

    // 路径映射：访问根路径指向index.html
    let key = url.pathname === "/" ? "index.html" : url.pathname.slice(1);

    // 尝试读取R2存储
    let object = await env.R2_BUCKET.get(key);

    // R2不存在文件 → 镜像回源缤纷云，写入R2（入库前清洗Header）
    if (!object) {
      try {
        const originUrl = "https://ros.flowmoon.cn" + url.pathname;
        const originResponse = await fetch(originUrl);
        if (!originResponse.ok) throw new Error("源站资源不存在");

        const arrayBuffer = await originResponse.arrayBuffer();
        // ========== 入库前清洗上游缤纷云脏头部【永久根治关键】 ==========
        const cleanMetaHeaders = new Headers(originResponse.headers);
        const removeList = [
          "X-Bitiful-Server-Time",
          "X-Bitiful-Ts-Dt",
          "X-Amz-Request-Id",
          "X-Amz-Meta-Checksum-Sha256",
          "X-Amz-Meta-S3b-Last-Modified",
          "Content-Disposition" // 删除源站强制下载标记
        ];
        removeList.forEach(name => cleanMetaHeaders.delete(name));

        // 写入R2，使用清洗后的元数据
        await env.R2_BUCKET.put(key, arrayBuffer, {
          httpMetadata: cleanMetaHeaders
        });

        // 重新读取存入后的对象
        object = await env.R2_BUCKET.get(key);
      } catch (err) {
        return new Response("Not Found", { status: 404 });
      }
    }

    // 组装响应头
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // 兜底：再次清理头部（兼容R2存量旧文件）
    const removeList = [
      "X-Bitiful-Server-Time",
      "X-Bitiful-Ts-Dt",
      "X-Amz-Request-Id",
      "X-Amz-Meta-Checksum-Sha256",
      "X-Amz-Meta-S3b-Last-Modified"
    ];
    removeList.forEach(name => headers.delete(name));

    // 统一缓存策略 和 EO/ESA对齐
    headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800");

    // ========== 根据后缀区分 inline预览 / 默认下载 ==========
    const previewExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'ico', 'svg', 'bmp',
      'txt', 'html', 'htm', 'css', 'js', 'json', 'xml', 'md', 'csv',
      'mp4', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'aac'];
    const ext = key.split('.').pop()?.toLowerCase();
    if (previewExts.includes(ext)) {
      headers.set("Content-Disposition", "inline");
    }
    // zip/rar/7z/gz/tar等压缩包：不设置该头，浏览器保持下载行为

    // 注入CORS跨域头
    const corsHeaders = getCorsHeaders();
    for (const [k, v] of corsHeaders) {
      headers.set(k, v);
    }

    // 安全响应头，对齐APISIX/EO/ESA标准
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-XSS-Protection", "1; mode=block");

    // 如需强制HTTPS，取消下方注释
    // headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    const response = new Response(object.body, { headers });
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  },
};

/** 复用CORS配置，GET和OPTIONS共用 */
function getCorsHeaders() {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "3600"
  });
}
