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

    // 仅允许GET/HEAD请求
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      const res = new Response("Method Not Allowed", { status: 405 });
      const h = getCorsHeaders();
      for (const [k, v] of h) res.headers.set(k, v);
      res.headers.set("Allow", "GET, HEAD, OPTIONS");
      return res;
    }

    // 缓存key忽略查询串，避免同一文件因?xxx参数不同造成缓存碎片
    const cacheKey = new Request(url.origin + url.pathname);
    const cache = caches.default;

    // 优先读取Cloudflare边缘缓存
    let cachedRes = await cache.match(cacheKey);
    if (cachedRes) {
      // HEAD只返回头部，不带body
      return isHead
        ? new Response(null, { status: cachedRes.status, headers: cachedRes.headers })
        : cachedRes;
    }

    // 路径映射：访问根路径指向index.html
    let key = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    // 解码URL转义（中文文件名/%20空格等），匹配R2中的真实key
    try { key = decodeURIComponent(key); } catch (e) { /* 转义非法则保持原样 */ }

    // 尝试读取R2存储
    let object = await env.R2_BUCKET.get(key);

    // R2不存在文件 → 镜像回源缤纷云，写入R2（入库前清洗Header）
    if (!object) {
      try {
        const originUrl = ORIGIN_BASE + url.pathname;
        // 15秒超时，防止源站挂起拖垮Worker
        const originResponse = await fetch(originUrl, { signal: AbortSignal.timeout(15000) });
        if (!originResponse.ok) throw new Error("源站资源不存在");
        object = await mirrorToR2(env, key, originResponse);
      } catch (err) {
        // 回源失败 → 返回/404.html页面内容（带404状态码）
        return notFoundResponse(env);
      }
    }

    // 组装响应头
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // 再次清理头部（兼容R2存量旧文件）
    REMOVE_HEADERS.forEach(name => headers.delete(name));

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

    // ========= 删除了 X-Content-Type-Options、X-Xss-Protection 两行 =========

    // 如需强制HTTPS，取消下方注释
    // headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    // HEAD只返回头部不占用body，且不写边缘缓存（避免无body响应污染GET缓存）
    const response = new Response(isHead ? null : object.body, { headers });
    if (!isHead) {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    }

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

/** 缤纷云源站地址 */
const ORIGIN_BASE = "https://elaina.cn-nb1.rains3.com";

/** 入库/响应统一清理的上游Header列表 */
const REMOVE_HEADERS = [
  "X-Bitiful-Server-Time",
  "X-Bitiful-Ts-Dt",
  "X-Bitiful-Force-Attachment",
  "X-Amz-Request-Id",
  "X-Amz-Meta-Checksum-Sha256",
  "X-Amz-Meta-S3b-Last-Modified"
];

/** 将源站响应清洗Header后写入R2，并重新读取返回对象 */
async function mirrorToR2(env, key, originResponse) {
  const arrayBuffer = await originResponse.arrayBuffer();
  // ========== 入库前清洗上游缤纷云头部==========
  const cleanMetaHeaders = new Headers(originResponse.headers);
  REMOVE_HEADERS.forEach(name => cleanMetaHeaders.delete(name));
  cleanMetaHeaders.delete("Content-Disposition"); // 删除源站强制下载标记

  // 写入R2，使用清洗后的元数据
  await env.R2_BUCKET.put(key, arrayBuffer, {
    httpMetadata: cleanMetaHeaders
  });

  // 重新读取存入后的对象
  return await env.R2_BUCKET.get(key);
}

/** 404兜底页：读取R2中的404.html（无则回源镜像一次），以404状态码返回其内容 */
async function notFoundResponse(env) {
  let object = await env.R2_BUCKET.get("404.html").catch(() => null);

  // R2里没有404.html → 回源缤纷云镜像一份（复用清洗逻辑）
  if (!object) {
    try {
      const originResponse = await fetch(ORIGIN_BASE + "/404.html", { signal: AbortSignal.timeout(15000) });
      if (!originResponse.ok) throw new Error("源站404页面不存在");
      object = await mirrorToR2(env, "404.html", originResponse);
    } catch (err) {
      // 彻底没有 → 返回纯文本兜底
      return new Response("Not Found", { status: 404 });
    }
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "no-store"); // 404不进缓存
  const corsHeaders = getCorsHeaders();
  for (const [k, v] of corsHeaders) {
    headers.set(k, v);
  }

  return new Response(object.body, { status: 404, headers });
}
