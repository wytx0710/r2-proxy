/**
 * R2 镜像代理 —— 对象存储直连版
 *
 * 取数链路：Cloudflare 边缘缓存 → R2 → S3 兼容对象存储（SigV4 签名）→ 回写 R2
 * 对象存储凭据全部来自环境变量，不写死在代码里。
 *
 * 必需环境变量：
 *   S3_ENDPOINT        S3 兼容端点，如 https://majo.s3.bitiful.net
 *   S3_REGION          区域标识，如 ap-guangzhou（部分厂商可填任意值）
 *   S3_BUCKET          桶名
 *   S3_ACCESS_KEY_ID   访问密钥 ID
 *   S3_SECRET_ACCESS_KEY 访问密钥（只读权限即可）
 *
 * 可选环境变量：
 *   S3_PATH_STYLE      "path"（默认，兼容自建/MinIO）/ "virtual"（bucket 走子域名）
 *   S3_FETCH_TIMEOUT   回源超时毫秒数，默认 15000
 *
 * 绑定变量：
 *   R2_BUCKET          Cloudflare R2 桶绑定
 */

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    // 处理 OPTIONS 跨域预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 仅允许 GET/HEAD 请求
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      const res = new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
      res.headers.set("Allow", "GET, HEAD, OPTIONS");
      return res;
    }

    // 缓存 key 忽略查询串，避免同一文件因 ?xxx 参数不同造成缓存碎片
    const cacheKey = new Request(url.origin + url.pathname);
    const cache = caches.default;

    // 优先读取 Cloudflare 边缘缓存
    const cachedRes = await cache.match(cacheKey);
    if (cachedRes) {
      // HEAD 只返回头部，不带 body
      return isHead
        ? new Response(null, { status: cachedRes.status, headers: cachedRes.headers })
        : cachedRes;
    }

    // 路径映射：访问根路径指向 index.html
    let key = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    // 解码 URL 转义（中文文件名 / %20 空格等），匹配存储中的真实 key
    try { key = decodeURIComponent(key); } catch (e) { /* 转义非法则保持原样 */ }

    // 阻断路径穿越（../ 之类），非法路径直接 400
    if (!isSafeKey(key)) {
      return new Response("Bad Request", { status: 400, headers: corsHeaders() });
    }

    // 尝试读取 R2
    let object = await env.R2_BUCKET.get(key);

    // R2 不存在 → 从 S3 兼容对象存储拉取，写入 R2（不携带源站元数据）
    if (!object) {
      try {
        const originResponse = await fetchFromS3(env, key);
        object = await mirrorToR2(env, key, originResponse);
      } catch (err) {
        // 拉取失败 → 返回 404.html 页面内容（带 404 状态码）
        return notFoundResponse(env);
      }
    }

    // 组装响应头
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // 纠正内容类型：兼容 R2 中存量的旧对象（入库时类型不准）
    headers.set("Content-Type", resolveContentType(key, headers.get("Content-Type")));

    // 统一缓存策略
    headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800");

    // ========== 根据后缀区分 inline 预览 / 默认下载 ==========
    const ext = key.split(".").pop()?.toLowerCase();
    if (PREVIEW_EXTS.includes(ext)) {
      // 带上 RFC 5987 编码的文件名，中文名下载时不会乱码或丢失
      headers.set(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(key.split("/").pop())}`
      );
    }
    // zip/rar/7z/gz/tar 等压缩包：不设置该头，浏览器保持下载行为

    // 注入 CORS 跨域头
    applyCors(headers);

    // HEAD 只返回头部不占用 body，且不写边缘缓存（避免无 body 响应污染 GET 缓存）
    const response = new Response(isHead ? null : object.body, { headers });
    if (!isHead) {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};

/**
 * CORS 响应头，模块级常量。
 * 每次请求都 new 一个 Headers 纯属浪费，这里建一次复用。
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "3600",
};

/** 把预设的 CORS 头逐条拷入目标 Headers */
function applyCors(headers) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return headers;
}

/** 直接生成一份可用的 CORS Headers 实例 */
function corsHeaders() {
  return new Headers(CORS_HEADERS);
}

/** inline 预览后缀白名单；压缩包类不在其中，浏览器保持下载 */
const PREVIEW_EXTS = [
  "jpg", "jpeg", "png", "gif", "webp", "avif", "ico", "svg", "bmp",
  "txt", "html", "htm", "css", "js", "json", "xml", "md", "csv",
  "mp4", "webm", "mp3", "wav", "flac", "m4a", "aac",
];

/**
 * 空字符串的 SHA256 十六进制值。
 * GET 请求体恒为空，签名时用真实哈希而非 UNSIGNED-PAYLOAD 占位符，
 * 可兼容会严格校验 x-amz-content-sha256 的 S3 实现。
 */
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * 后缀 → MIME 映射。
 * 对象入库时不携带源站元数据，类型一律在响应阶段按后缀推断。
 */
const MIME_FALLBACK = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  zip: "application/zip",
};

/** 统一修正内容类型：无类型、octet-stream 或缺 charset 的文本类都按后缀纠正 */
function resolveContentType(key, upstreamType) {
  const ext = key.split(".").pop()?.toLowerCase();
  const fallback = MIME_FALLBACK[ext];

  // 上游没给类型，或给了通用二进制类型 → 直接用后缀推断
  if (!upstreamType || upstreamType.includes("application/octet-stream")) {
    return fallback || "application/octet-stream";
  }
  // 文本类补上 charset，否则中文会乱码
  if (fallback && fallback.includes("charset") && !/charset=/i.test(upstreamType)) {
    return `${upstreamType}; charset=utf-8`;
  }
  return upstreamType;
}

/** 校验对象 key，禁止路径穿越与空 key */
function isSafeKey(key) {
  if (!key || key.length > 1024) return false;
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) return false;
  // 允许子目录，但不允许空片段
  return !key.split("/").some((seg) => seg === "");
}

/** 解析后的配置缓存：同一 isolate 生命周期内环境变量不变 */
let s3ConfigCache = null;

/** 读取对象存储配置，缺失时抛出可读错误；结果缓存复用 */
function getS3Config(env) {
  if (s3ConfigCache) return s3ConfigCache;

  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  const missing = [];
  if (!S3_ENDPOINT) missing.push("S3_ENDPOINT");
  if (!S3_BUCKET) missing.push("S3_BUCKET");
  if (!S3_ACCESS_KEY_ID) missing.push("S3_ACCESS_KEY_ID");
  if (!S3_SECRET_ACCESS_KEY) missing.push("S3_SECRET_ACCESS_KEY");
  if (missing.length) {
    throw new Error("缺少环境变量: " + missing.join(", "));
  }
  s3ConfigCache = {
    endpoint: S3_ENDPOINT.replace(/\/+$/, ""),
    // 多数厂商会校验 region，缺失时用默认值兜底
    region: S3_REGION || "us-east-1",
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    pathStyle: (env.S3_PATH_STYLE || "path") !== "virtual",
    timeout: Number(env.S3_FETCH_TIMEOUT) || 15000,
  };
  return s3ConfigCache;
}

/**
 * 构造对象在存储中的完整 URL。
 * path 风格：https://endpoint/bucket/key —— 自建存储、MinIO、缤纷云默认走这个
 * virtual 风格：https://bucket.endpoint/key —— AWS S3 等云厂商使用
 */
function buildObjectUrl(cfg, key) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");

  if (cfg.pathStyle) {
    return `${cfg.endpoint}/${encodeURIComponent(cfg.bucket)}/${encodedKey}`;
  }

  // virtual 风格需把 bucket 提到子域名：bucket.endpoint
  const u = new URL(cfg.endpoint);
  u.hostname = `${encodeURIComponent(cfg.bucket)}.${u.hostname}`;
  return `${u.origin}/${encodedKey}`;
}

/**
 * 以 AWS Signature V4 签名方式 GET 对象。
 * 纯原生实现，Workers 运行时无需任何依赖。
 */
async function fetchFromS3(env, key) {
  const cfg = getS3Config(env);
  const targetUrl = buildObjectUrl(cfg, key);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T000000Z
  const dateStamp = amzDate.slice(0, 8);                          // 20260101

  const u = new URL(targetUrl);
  const canonicalUri = u.pathname;
  const canonicalQuery = u.searchParams.size === 0 ? "" : "?" + u.searchParams.toString();

  // 需要参与签名的头（host + x-amz-*）
  const headersToSign = {
    host: u.host,
    "x-amz-content-sha256": EMPTY_BODY_SHA256,
    "x-amz-date": amzDate,
  };

  const signedHeaderNames = Object.keys(headersToSign).sort();
  const canonicalHeaders =
    signedHeaderNames.map((n) => `${n}:${headersToSign[n]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_BODY_SHA256,
  ].join("\n");

  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await hmac(
    await hmac(
      await hmac(await hmac("AWS4" + cfg.secretAccessKey, dateStamp), cfg.region),
      "s3"
    ),
    "aws4_request"
  );
  const signature = bytesToHex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(targetUrl, {
    method: "GET",
    headers: { ...headersToSign, Authorization: authorization },
    signal: AbortSignal.timeout(cfg.timeout),
  });

  if (!res.ok) {
    throw new Error(`对象存储返回 ${res.status}`);
  }
  return res;
}

/**
 * 将源站响应流式写入 R2，不携带任何上游元数据。
 *
 * 直接透传 ReadableStream 而非 arrayBuffer，避免大文件撑爆 Worker 内存。
 * 用 tee() 分流：一份写入 R2，一份直接回给用户，无需把整个文件读进内存，
 * 也省去写入后再 get 一次的往返。
 *
 * 返回可直接用于响应的对象句柄，结构对齐 R2Object。
 */
async function mirrorToR2(env, key, originResponse) {
  // tee 出两条独立分支，两边可同时消费
  const [toR2, toClient] = originResponse.body.tee();

  // 不写入任何上游元数据：源站的 Content-Disposition、Content-Type 均不采纳，
  // 类型统一由响应侧 resolveContentType() 按后缀推断
  const result = await env.R2_BUCKET.put(key, toR2);

  // 最小 R2Object 替身，供上层统一走 writeHttpMetadata + body 的读取路径。
  // 元数据为空，writeHttpMetadata 不写入任何头，类型由后缀推断决定。
  return {
    body: toClient,
    httpEtag: result.httpEtag,
    writeHttpMetadata() {},
  };
}

/** 404 兜底页：读取 R2 中的 404.html（无则从对象存储拉一次），以 404 状态码返回其内容 */
async function notFoundResponse(env) {
  let object = await env.R2_BUCKET.get("404.html").catch(() => null);

  // R2 里没有 404.html → 从对象存储镜像一份
  if (!object) {
    try {
      const originResponse = await fetchFromS3(env, "404.html");
      object = await mirrorToR2(env, "404.html", originResponse);
    } catch (err) {
      // 彻底没有 → 返回纯文本兜底
      return new Response("Not Found", { status: 404, headers: corsHeaders() });
    }
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "no-store"); // 404 不进缓存
  applyCors(headers);

  return new Response(object.body, { status: 404, headers });
}

/* ---------------- 加密工具（Web Crypto） ---------------- */

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}
