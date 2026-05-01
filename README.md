# Cloudflare Worker R2 静态资源代理 & 缓存服务
一个基于 **Cloudflare Workers** 实现的高性能静态资源代理服务，支持 **R2 存储托管 + 源站镜像回源 + 多级缓存**，一键实现静态资源全球加速、成本优化与高可用。

## 核心功能
- ✅ **仅允许 GET 请求**，自动拦截非 GET 请求并返回 405
- ✅ **Cloudflare 缓存优先**，命中缓存直接返回，极致加速
- ✅ **R2 存储托管**：优先从 Cloudflare R2 获取资源
- ✅ **智能镜像回源**：R2 无资源时自动从源站拉取并永久存入 R2
- ✅ **自动缓存写入**：响应后异步写入 Cloudflare 边缘缓存
- ✅ **标准 HTTP 缓存头**：优化浏览器 + CDN 缓存策略
- ✅ **根路径自动映射**：访问 `/` 自动返回 `index.html`

## 适用场景
- 静态网站 / 博客全球加速
- 图片、JS、CSS 等静态资源 CDN 加速
- 源站减负、降低带宽成本
- 高可用静态资源托管（R2 持久化 + 边缘缓存）

## 部署与配置
### 1. 前置准备
- 已创建 **Cloudflare R2 Bucket**
- 已创建 **Cloudflare Worker**
- 已为 Worker 绑定 R2 Bucket（变量名：`R2_BUCKET`）

### 2. 快速部署
1. 新建/编辑你的 Cloudflare Worker
2. 粘贴本项目代码
3. **修改回源地址**：
```javascript
// 替换为你的真实源站域名
const originUrl = "https://your-origin.com" + url.pathname;
```
4. 绑定 R2 Bucket 变量（变量名必须为：`R2_BUCKET`）
5. 部署生效

### 3. 路径规则
- 访问 `https://your-worker.your-subdomain.workers.dev/`
  → 自动返回 R2 中的 `index.html`
- 访问 `https://your-worker.your-subdomain.workers.dev/images/logo.png`
  → 读取 R2 中的 `images/logo.png`

## 工作流程
1. 接收请求 → 校验请求方法（仅 GET）
2. 查找 **Cloudflare 边缘缓存** → 命中直接返回
3. 未命中缓存 → 从 **R2 Bucket** 读取资源
4. R2 不存在 → 自动从**源站下载** → 存入 R2
5. 读取成功 → 返回资源并**异步写入边缘缓存**
6. 下次请求直接从缓存/R2读取，不再回源

## 响应头优化
```
Cache-Control: public, max-age=600, s-maxage=86400
ETag: 自动从 R2 获取
Content-Type: 自动识别资源类型
```
- `max-age=600`：浏览器缓存 10 分钟
- `s-maxage=86400`：CDN 边缘缓存 1 天

## 状态码说明
- `200 OK`：请求成功，返回资源
- `405 Method Not Allowed`：非 GET 请求被拦截
- `404 Not Found`：资源不存在（R2 + 源站均无）

## 许可证
MIT License
