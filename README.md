# Cloudflare Worker R2 静态资源代理 & 缓存服务
一个基于 **Cloudflare Pages 边缘函数** 实现的高性能静态资源代理服务，支持 **R2 存储托管 + 对象存储签名回源 + 多级缓存**，一键实现静态资源全球加速、成本优化与高可用托管。零服务器、零运维，全程依托 Cloudflare 全球 CDN 节点极速分发。

> **回源方式**：Worker 使用环境变量中的密钥，以 **AWS Signature V4** 签名直连任意 **S3 兼容对象存储**（阿里云 OSS / 腾讯 COS / 缤纷云 / AWS S3 / MinIO 均可），签名实现基于 Web Crypto 原生编写，**无需任何第三方依赖**。源站为私有读时同样正常取数。

---

## ✨ 核心特性
- ✅ **请求安全校验**：仅放行 GET/HEAD/OPTIONS，并阻断 `../` 路径穿越
- ✅ **边缘缓存优先**：Cloudflare 缓存命中直接返回内容，访问速度极致加速
- ✅ **R2 存储优先**：优先从 Cloudflare R2 对象存储读取资源，保护源站不暴露
- ✅ **智能镜像回源**：R2 无资源时，自动从对象存储拉取并**永久存入 R2** 持久化
- ✅ **SigV4 签名鉴权**：原生实现 AWS Signature V4，源站私有读也能直连取数，密钥走环境变量
- ✅ **流式回源入库**：`tee()` 分流后直传R2，不把整个文件读进 Worker 内存，大文件安全
- ✅ **Range 断点续传**：单段 Range 从 R2 切片读取、未命中时原样透传源站，返回 `206` + `Content-Range`；越界返回 `416`
- ✅ **条件请求 304**：`ETag` + `If-None-Match` 命中直接回 `304`，省流量省回源
- ✅ **错误码可区分**：源站 403/超时/5xx → `502`，配置缺失 → `500`，不再一律伪装成 `404`
- ✅ **HEAD 轻量响应**：只取元数据，不回源 GET、不写 R2，避免一次 HEAD 触发整文件镜像
- ✅ **R2 写入失败降级**：落盘异常时仍正常返回内容，下次请求重新镜像
- ✅ **中文文件名正确下载**：`Content-Disposition` 带 RFC 5987 编码，预览与下载都不乱码
- ✅ **MIME 按后缀推断**：入库不携带源站元数据，响应时按 32 个后缀映射推断类型，避免 octet-stream 导致预览失效
- ✅ **自动缓存写入**：资源响应后异步写入边缘缓存，后续访问不再重复回源
- ✅ **预览 / 下载分流**：图片音视频等走 `inline` 预览，压缩包保持下载行为
- ✅ **标准缓存头优化**：同时优化浏览器本地缓存 + CDN 边缘缓存双重策略
- ✅ **静态网站适配**：访问根路径 `/` 自动返回 R2 内的 `index.html`

---

## 🎯 适用场景
- 静态网站、个人博客、展示站**全球 CDN 加速**
- 图片、JS、CSS、字体等静态资源**专属 CDN 托管**
- **私有读对象存储**对外提供公开的 CDN 分发（源站密钥不暴露）
- 减轻源站压力，大幅降低**带宽成本与服务器负载**
- 高可用静态资源长期托管（R2 持久化 + 边缘多层缓存）

---

## 📁 项目目录结构
极简纯净结构，直接放在项目根目录即可，无需嵌套文件夹：
```
项目根目录
├─ _worker.js   # 核心代理、回源、缓存逻辑脚本
└─ README.md    # 项目说明文档
```

---

## ⚙️ Cloudflare Pages 部署配置
构建/部署无需复杂命令，按以下配置填写即可：
- 构建命令：`（留空）`
- 部署命令：`（留空）`
- 构建输出目录：`/`
- 根目录：`（留空）`

---

## 🔗 必做：R2 存储桶绑定
1. 提前创建 **Cloudflare R2 Bucket**
2. 进入 Pages 项目 → 设置 → 函数 → **R2 存储桶绑定**
3. **环境变量名称必须填写：`R2_BUCKET`**（代码已固定适配，不可修改）
4. 选择对应 Bucket 并保存

---

## 🚀 快速配置与上线
1. 将代码保存为 `_worker.js` 并上传至 GitHub 仓库
2. Cloudflare Pages 关联仓库完成自动部署
3. **配置对象存储环境变量**（见下方「🔑 环境变量配置」）

---

## 🔑 环境变量配置
对象存储凭据全部通过环境变量注入，代码里不写死任何密钥。

在 Pages 项目 → 设置 → 环境变量 中添加（生产 / 预览环境分别设置）：

| 变量名 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `S3_ENDPOINT` | ✅ | S3 兼容端点地址，末尾不带斜杠 | `https://s3.example.com` |
| `S3_BUCKET` | ✅ | 源对象存储桶名 | `my-assets` |
| `S3_ACCESS_KEY_ID` | ✅ | 访问密钥 ID | `AKIAxxxxxx` |
| `S3_SECRET_ACCESS_KEY` | ✅ | 访问密钥（**只读权限即可**） | `xxxxxx` |
| `S3_REGION` | ❌ | 区域标识，缺省按 `us-east-1` | `ap-guangzhou` |
| `S3_PATH_STYLE` | ❌ | URL 风格：`path`（默认，`endpoint/bucket/key`）/ `virtual`（`bucket.endpoint/key`） | `path` |
| `S3_FETCH_TIMEOUT` | ❌ | 回源超时毫秒，默认 `15000`（限制 1000~60000） | `15000` |

> ⚠️ 密钥类变量建议在 Cloudflare 控制台加密存储（Secret），不要提交进 Git 仓库。

**对象存储密钥所需权限**：只需 `s3:GetObject`（读单个对象）。若还希望 Worker 能拉取 `404.html`，该对象也要可读。

**为什么改用签名直连**：源站若为私有读，直接拼接公开 URL 会返回 403。启用 SigV4 签名后，无论源站是公开读还是私有读都能正常取数。

**签名兼容性**：`x-amz-content-sha256` 使用空请求体的真实 SHA256 值，而非 `UNSIGNED-PAYLOAD` 占位符。部分 S3 兼容实现（MinIO 老版本、OSS 兼容层）会校验并拒绝占位符，用真实哈希可兼容所有实现。

**大文件处理**：回源响应经 `tee()` 分流，一份写入 R2、一份直接返回用户，全程不将文件读入 Worker 内存（上限 128MB），因此不存在大文件撑爆内存的风险。回源遇到网络错误或 5xx 会**自动重试一次**；R2 写入失败时仍正常返回内容，下次请求再重新镜像。

---

## 📌 访问路径规则
- 访问 `https://xxx.pages.dev/`  
  → 自动返回 R2 中的 `index.html` 首页
- 访问 `https://xxx.pages.dev/images/logo.png`  
  → 优先读取 R2 对应路径资源

---

## 🔁 请求处理工作流程
1. 接收请求 → 仅放行 GET/HEAD/OPTIONS，校验路径合法性
2. HEAD 只查 R2 元数据（未命中则走源站 HEAD），不下载正文、不写缓存
3. GET 优先查询 **Cloudflare 边缘缓存**，命中直接返回（Range 请求跳过缓存，避免 206 污染完整对象）
4. 未命中缓存 → 从 **R2 Bucket** 读取资源；Range 请求只取对应切片
5. R2 无资源 → 从**对象存储（SigV4 签名鉴权）下载**；404 回退 `404.html`，403/超时/5xx 回 `502`
6. 完整响应**流式镜像入 R2**，并**异步写入边缘缓存**；Range 切片不落盘
7. 请求带 `If-None-Match` 且与 ETag 一致 → 直接回 `304`
8. 后续请求直接走缓存/R2，不再频繁回源

---

## 📄 响应头与缓存策略
```http
Cache-Control: public, max-age=86400, s-maxage=604800
ETag: 自动从 R2 获取
Content-Type: 按文件后缀推断（不采纳源站类型）
Content-Disposition: 预览类后缀inline（带 RFC 5987 文件名），压缩包类不设置
Accept-Ranges: bytes
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
```
- `max-age=86400`：浏览器本地缓存 1 天
- `s-maxage=604800`：Cloudflare CDN 边缘缓存 7 天
- **Range 响应**：返回 `206` + `Content-Range`，`Cache-Control` 只保留 `max-age`，不写入 Worker 边缘缓存
- **304 响应**：只回 `ETag` 与 `Cache-Control`，不带正文
- **Content-Type 按后缀推断**：对象入库时**不携带任何源站元数据**，响应阶段统一按文件后缀推断类型。这样既避免了对象存储把 `.js`/`.css`/字体返回成 `application/octet-stream` 导致预览失效，也避免了源站的 `Content-Disposition: attachment` 被持久化后覆盖下载/预览判断。内置 32 个后缀的 MIME 映射，识别不出的后缀才回落到 `application/octet-stream`。
- **预览 / 下载分流**：图片、音视频、文本、样式脚本走 `inline` 直接预览；`zip`/`rar`/`7z` 等压缩包不设该头，保持浏览器默认下载行为。预览时会附带 `filename*=UTF-8''...`，中文文件名下载不会乱码或丢失，文件名中的 `'()*` 也会转义。

---

## 📊 状态码说明
- `200 OK`：请求成功，正常返回资源
- `204 No Content`：OPTIONS 跨域预检通过
- `206 Partial Content`：Range 切片命中，响应带 `Content-Range`
- `304 Not Modified`：`If-None-Match` 与 ETag 一致，可继续使用本地缓存
- `400 Bad Request`：路径非法（含 `../` 等路径穿越特征）
- `404 Not Found`：R2 与对象存储均无对应资源，返回 `404.html` 页面内容（若该文件也不存在，退化为纯文本 `Not Found`）
- `405 Method Not Allowed`：非 GET/HEAD/OPTIONS 请求被拦截
- `416 Range Not Satisfiable`：请求区间越界，响应带 `Content-Range: bytes */对象大小`
- `500 Proxy Configuration Error`：环境变量缺失或 R2 绑定未配置
- `502 Bad Gateway`：源站 403、超时或 5xx，Worker 无法取得对象（不再伪装成 404）

---

## 📄 许可证
MIT License
