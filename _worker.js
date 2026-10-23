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
 *   S3_FETCH_TIMEOUT   回源超时毫秒数，默认 15000，限制在 1000~60000
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

    // 路径映射：访问根路径指向 index.html
    let key = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    // 解码 URL 转义（中文文件名 / %20 空格等），匹配存储中的真实 key
    try {
      key = decodeURIComponent(key);
    } catch (e) {
      /* 转义非法则保持原样，交给 isSafeKey 兜底 */
    }

    // 阻断路径穿越（../ 之类），非法路径直接 400
    if (!isSafeKey(key)) {
      return new Response("Bad Request", { status: 400, headers: corsHeaders() });
    }

    const ifNoneMatch = request.headers.get("if-none-match");
    const range = parseRange(request.headers.get("range"));

    try {
      if (!env.R2_BUCKET) throw new ConfigError("缺少 R2_BUCKET 存储桶绑定");
      // HEAD 只取元数据，不下载正文、不写缓存
      if (isHead) return await handleHead(env, key, ifNoneMatch);
      return await handleGet(request, env, context, url, key, ifNoneMatch, range);
    } catch (err) {
      return errorResponse(err);
    }
  },
};

/**
 * GET 主流程：边缘缓存 → R2 → 回源 → 回写 R2 / 边缘缓存
 */
async function handleGet(request, env, context, url, key, ifNoneMatch, range) {
  // 缓存 key 忽略查询串，避免同一文件因 ?xxx 参数不同造成缓存碎片
  const cacheKey = new Request(url.origin + url.pathname);
  const cache = caches.default;

  // Range 请求不读写边缘缓存：避免 206 切片覆盖完整对象
  if (!range) {
    const cachedRes = await cache.match(cacheKey);
    if (cachedRes) {
      return isNotModified(cachedRes.headers.get("etag"), ifNoneMatch)
        ? notModifiedResponse(cachedRes.headers.get("etag"))
        : cachedRes;
    }
  }

  // 优先读取 R2；带 Range 时只取切片，避免为一次拖动下载整个文件
  let object;
  try {
    object = await env.R2_BUCKET.get(key, range ? { range } : undefined);
  } catch (err) {
    // 部分 R2 实现对越界区间直接抛错，这里转成 416 而不是 502
    if (range) {
      const meta = await env.R2_BUCKET.head(key).catch(() => null);
      if (meta) return rangeNotSatisfiableResponse(meta.size);
    }
    throw err;
  }

  if (object) {
    if (range && isRangeUnsatisfiable(range, object)) {
      return rangeNotSatisfiableResponse(object.size);
    }

    const headers = buildObjectHeaders(object, key, range);
    if (!range && isNotModified(object.httpEtag, ifNoneMatch)) {
      return notModifiedResponse(object.httpEtag);
    }

    const res = new Response(object.body, { status: range ? 206 : 200, headers });
    if (!range) {
      context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
    }
    return res;
  }

  // R2 无资源 → 从对象存储拉取；Range 原样透传给源站
  const originRes = await fetchFromS3(env, key, {
    range: range ? request.headers.get("range") : null,
  });

  // 源站 404 才回退到 404.html，其余错误由 errorResponse 区分成 502
  if (originRes.status === 404) return notFoundResponse(env);

  // 源站判定区间越界（416）：透传状态码与 Content-Range，不当作回源故障
  if (range && originRes.status === 416) {
    const headers = buildOriginHeaders(originRes, key);
    if (originRes.body) await originRes.body.cancel().catch(() => {});
    return new Response(null, { status: 416, headers });
  }

  if (!originRes.ok) throw new OriginError(originRes.status);

  // 切片内容不入库、不缓存，直接 206 透传
  if (range) {
    const body = originRes.body;
    return new Response(body, {
      status: originRes.status === 206 ? 206 : 200,
      headers: buildOriginHeaders(originRes, key),
    });
  }

  // 条件请求命中：不必把整个对象写进 R2，直接 304
  if (isNotModified(originRes.headers.get("etag"), ifNoneMatch)) {
    if (originRes.body) await originRes.body.cancel().catch(() => {});
    return notModifiedResponse(originRes.headers.get("etag"));
  }

  const mirrored = await mirrorToR2(env, key, originRes);
  const res = new Response(mirrored.body, {
    headers: buildObjectHeaders(mirrored, key, null),
  });
  context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}

/**
 * HEAD 流程：R2 元数据 → 源站 HEAD。
 * 不回源 GET、不写 R2，避免"一次 HEAD 触发整文件镜像"。
 */
async function handleHead(env, key, ifNoneMatch) {
  const object = await env.R2_BUCKET.head(key);
  if (object) {
    if (isNotModified(object.httpEtag, ifNoneMatch)) {
      return notModifiedResponse(object.httpEtag);
    }
    return new Response(null, { headers: buildObjectHeaders(object, key, null) });
  }

  const originRes = await fetchFromS3(env, key, { method: "HEAD" });
  if (originRes.status === 404) {
    if (originRes.body) await originRes.body.cancel().catch(() => {});
    const headers = corsHeaders();
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 404, headers });
  }
  if (!originRes.ok) throw new OriginError(originRes.status);

  return new Response(null, { headers: buildOriginHeaders(originRes, key) });
}

/** 配置缺失（环境变量 / 绑定）时抛出，映射成 500 而不是 404 */
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 源站返回非 2xx（404/416 已单独处理），映射成 502 */
class OriginError extends Error {
  constructor(status) {
    super(`对象存储返回 ${status}`);
    this.name = "OriginError";
    this.status = status;
  }
}

/**
 * 统一错误响应：
 * - 配置问题 → 500，提示运维补变量
 * - 源站超时 / 403 / 5xx → 502，不再伪装成 404
 */
function errorResponse(err) {
  if (err instanceof ConfigError) {
    console.error("[r2-proxy] 配置错误:", err.message);
    return plainResponse(500, "Proxy Configuration Error");
  }
  console.error("[r2-proxy] 回源失败:", err && err.message ? err.message : err);
  return plainResponse(502, "Bad Gateway");
}

function plainResponse(status, text) {
  const headers = corsHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(text, { status, headers });
}

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
 * GET/HEAD 请求体恒为空，签名时用真实哈希而非 UNSIGNED-PAYLOAD 占位符，
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

/* ---------------- Range / 条件请求 ---------------- */

/**
 * 解析单段 Range 头，返回 R2 的 range 选项。
 * 多段 Range（bytes=0-1,5-6）与非法格式一律返回 null → 按完整对象响应。
 */
function parseRange(header) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;

  // 后缀形式 bytes=-500：取最后 500 字节
  if (!startRaw) {
    const suffix = Number(endRaw);
    return suffix > 0 ? { suffix } : null;
  }

  const offset = Number(startRaw);
  if (!endRaw) return { offset };

  const end = Number(endRaw);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}

/** 判断请求区间是否完全越界（起始位置不小于对象总长） */
function isRangeUnsatisfiable(range, object) {
  if (typeof object.size !== "number") return false;
  const served = object.range;
  if (served && typeof served.offset === "number") return served.offset >= object.size;
  if (typeof range.offset === "number") return range.offset >= object.size;
  return false;
}

/** 返回 416，并带上对象总长，便于客户端重新计算区间 */
function rangeNotSatisfiableResponse(size) {
  const headers = corsHeaders();
  headers.set("Content-Range", `bytes */${typeof size === "number" ? size : "*"}`);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 416, headers });
}

/** 判定 If-None-Match 是否命中当前 ETag（支持弱比较与 *） */
function isNotModified(etag, ifNoneMatch) {
  if (!etag || !ifNoneMatch) return false;
  const target = etag.replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === "*" || v === target);
}

/** 304 只回 ETag 与缓存策略，不带正文 */
function notModifiedResponse(etag) {
  const headers = corsHeaders();
  if (etag) headers.set("ETag", etag);
  headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800");
  return new Response(null, { status: 304, headers });
}

/* ---------------- 响应头组装 ---------------- */

/**
 * 由 R2 对象（或镜像替身）生成响应头。
 * Range 请求下补 Content-Range，完整响应补 Content-Length。
 */
function buildObjectHeaders(object, key, range) {
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") object.writeHttpMetadata(headers);

  // 元数据不可信：类型按后缀推断，下载/预览头由本服务统一下发
  headers.delete("Content-Disposition");
  headers.set("Content-Type", resolveContentType(key, headers.get("Content-Type")));
  headers.set(
    "Cache-Control",
    range ? "public, max-age=86400" : "public, max-age=86400, s-maxage=604800"
  );
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Content-Type-Options", "nosniff");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);

  applyContentDisposition(headers, key);
  applyLengthAndRange(headers, object, range);
  applyCors(headers);
  return headers;
}

/** 源站直出（206 切片透传）时的响应头，仅采信长度与区间信息 */
function buildOriginHeaders(originRes, key) {
  const headers = new Headers();
  headers.set("Content-Type", resolveContentType(key, originRes.headers.get("Content-Type")));
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Content-Type-Options", "nosniff");

  const length = originRes.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  const contentRange = originRes.headers.get("Content-Range");
  if (contentRange) headers.set("Content-Range", contentRange);
  const etag = originRes.headers.get("ETag");
  if (etag) headers.set("ETag", etag);

  applyContentDisposition(headers, key);
  applyCors(headers);
  return headers;
}

/**
 * 预览类后缀加 inline + RFC 5987 文件名；压缩包等不下发该头，保持下载行为。
 * 文件名中的 ' ( ) * 必须转义，否则 filename* 解析会截断。
 */
function applyContentDisposition(headers, key) {
  const filename = key.split("/").pop() || "";
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (!PREVIEW_EXTS.includes(ext)) return;

  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encoded}`);
}

/** 写入 Content-Length；Range 响应额外写 Content-Range */
function applyLengthAndRange(headers, object, range) {
  const fullSize = typeof object.size === "number" ? object.size : null;

  if (!range) {
    if (fullSize !== null) headers.set("Content-Length", String(fullSize));
    return;
  }

  const served = object.range;
  const start =
    served && typeof served.offset === "number"
      ? served.offset
      : typeof range.offset === "number"
        ? range.offset
        : 0;

  let length = served && typeof served.length === "number" ? served.length : null;
  if (length === null && fullSize !== null) length = fullSize - start;
  if (length === null && typeof range.length === "number") length = range.length;

  if (length !== null && length >= 0) headers.set("Content-Length", String(length));
  if (fullSize !== null && length !== null && length > 0) {
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${fullSize}`);
  }
}

/* ---------------- 对象存储配置与签名 ---------------- */

/**
 * 读取对象存储配置。
 * 不做模块级缓存：读取 env 的开销远小于一次网络往返，
 * 缓存反而会在变量变更（同 isolate 复用时）留下脏配置。
 */
function getS3Config(env) {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;

  const missing = [];
  if (!S3_ENDPOINT) missing.push("S3_ENDPOINT");
  if (!S3_BUCKET) missing.push("S3_BUCKET");
  if (!S3_ACCESS_KEY_ID) missing.push("S3_ACCESS_KEY_ID");
  if (!S3_SECRET_ACCESS_KEY) missing.push("S3_SECRET_ACCESS_KEY");
  if (missing.length) throw new ConfigError("缺少环境变量: " + missing.join(", "));

  return {
    endpoint: S3_ENDPOINT.replace(/\/+$/, ""),
    // 多数厂商会校验 region，缺失时用默认值兜底
    region: S3_REGION || "us-east-1",
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    pathStyle: (env.S3_PATH_STYLE || "path") !== "virtual",
    timeout: normalizeTimeout(env.S3_FETCH_TIMEOUT),
  };
}

/** 超时兜底并限制在 1s~60s，避免误配成 0 或超大值 */
function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 15000;
  return Math.min(Math.max(n, 1000), 60000);
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
 * 回源请求，网络错误与 5xx 自动重试一次。
 * 404/403 等确定性错误不重试，交给调用方区分 404 与 502。
 */
async function fetchFromS3(env, key, { method = "GET", range = null } = {}) {
  const cfg = getS3Config(env);
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await sendSignedRequest(cfg, key, method, range);

      if (res.status >= 500 && attempt < maxAttempts) {
        if (res.body) await res.body.cancel().catch(() => {});
        lastError = new OriginError(res.status);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
    }
  }

  throw lastError || new Error("回源失败");
}

/**
 * 以 AWS Signature V4 签名方式请求对象。
 * 纯原生实现，Workers 运行时无需任何依赖。
 */
async function sendSignedRequest(cfg, key, method, range) {
  const targetUrl = buildObjectUrl(cfg, key);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T000000Z
  const dateStamp = amzDate.slice(0, 8); // 20260101

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
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${headersToSign[n]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
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
    await hmac(await hmac(await hmac("AWS4" + cfg.secretAccessKey, dateStamp), cfg.region), "s3"),
    "aws4_request"
  );
  const signature = bytesToHex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = { ...headersToSign, Authorization: authorization };
  // Range 不参与签名：S3 兼容实现允许未签名的 Range 头
  if (range) headers.Range = range;

  return fetch(targetUrl, {
    method,
    headers,
    signal: AbortSignal.timeout(cfg.timeout),
  });
}

/* ---------------- 镜像入库与 404 兜底 ---------------- */

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
  const [toR2, toClient] = originResponse.body.tee();
  const size = parseSize(originResponse.headers.get("Content-Length"));
  const fallback = { body: toClient, size, writeHttpMetadata() {} };

  try {
    const result = await env.R2_BUCKET.put(key, toR2);
    return { ...fallback, httpEtag: result && result.httpEtag };
  } catch (err) {
    // 落盘失败不影响本次响应：客户端照常拿到内容，下次请求再回源
    console.error("[r2-proxy] 写入 R2 失败:", err);
    // tee 的另一支由客户端消费；这里不能 await，否则可能一直等另一支结束
    if (toR2) toR2.cancel().catch(() => {});
    return fallback;
  }
}

function parseSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** 404 兜底页：读取 R2 中的 404.html（无则从对象存储拉一次），以 404 状态码返回其内容 */
async function notFoundResponse(env) {
  let object = await env.R2_BUCKET.get("404.html").catch(() => null);

  // R2 里没有 404.html → 从对象存储镜像一份
  if (!object) {
    try {
      const originRes = await fetchFromS3(env, "404.html");
      if (!originRes.ok) {
        if (originRes.body) await originRes.body.cancel().catch(() => {});
        return plainResponse(404, "Not Found");
      }
      object = await mirrorToR2(env, "404.html", originRes);
    } catch (err) {
      // 彻底没有 → 返回纯文本兜底
      return plainResponse(404, "Not Found");
    }
  }

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") object.writeHttpMetadata(headers);
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "no-store"); // 404 不进缓存
  headers.set("X-Content-Type-Options", "nosniff");
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
