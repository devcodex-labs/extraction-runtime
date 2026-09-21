# extraction-runtime

[English](README.md) | **简体中文**

`@devcodex-labs/extraction-runtime` 使用 Mistral OCR 从文档和图片 URL 中提取结构化 JSON，也提供 TXT、Markdown、JSON、CSV 和 HTML 的本地文本解析能力。

## 目录

- [安装](#安装)
- [结构化提取](#结构化提取)
- [配置](#配置)
- [响应与错误](#响应与错误)
- [运行边界](#运行边界)
- [本地文本提取](#本地文本提取)

## 安装

```sh
npm install @devcodex-labs/extraction-runtime
```

要求 Node.js 20+。本包仅支持 ESM，并随包安装其 TypeScript 声明引用的 Node.js 类型定义；没有运行时 JavaScript 依赖。

## 结构化提取

模型清单是静态的，无需凭据，不发起网络请求：

```js
import { listExtractionModels } from "@devcodex-labs/extraction-runtime";

const models = listExtractionModels();
// [{ provider: "mistral", model: "mistral-ocr-4-1", name: "Mistral OCR 4.1",
//    inputKinds: ["image", "document"], status: "active" }]
```

每次调用都会返回一个新的、深度冻结的清单。`active` 表示适配器支持该模型，不代表你的账号已验证可用。

### 提取文档

以下代码可作为应用的 `extract.mjs` 入口：

```js
import {
  extractStructured,
  ExtractionRuntimeError,
} from "@devcodex-labs/extraction-runtime";

const apiKey = process.env.MISTRAL_API_KEY;
const documentUrl = process.env.INVOICE_URL;
if (!apiKey || !documentUrl) throw new Error("Provide a key and document URL.");

try {
  const result = await extractStructured({
    provider: "mistral",
    model: "mistral-ocr-4-1",
    apiKey,
    timeoutMs: 120_000,
    schema: {
      type: "object",
      properties: {
        invoiceNumber: { type: "string" },
        total: { type: "number" },
      },
      required: ["invoiceNumber", "total"],
      additionalProperties: false,
    },
    prompt: "Extract the invoice number and total.",
    inputs: [{ id: "invoice-1", kind: "document", url: documentUrl }],
    // providerOptions: { pages: [0] }, // 可选，页码从 0 开始。
  });

  for (const item of result.items) {
    if (item.status === "success") {
      // 使用提取值前，请先校验业务规则。
      console.log(item.index, item.id, item.data);
    } else {
      console.error(item.index, item.error.code, item.error.message);
    }
  }
} catch (error) {
  if (error instanceof ExtractionRuntimeError) {
    console.error(error.code, error.message); // 整次调用被拒绝，未发起请求。
  } else throw error;
}
```

设置 Mistral API Key 和 Mistral 可访问的文档 URL，然后运行入口文件。请求使用你的 Mistral 账号，可能产生服务商费用。

PowerShell：

```powershell
$env:MISTRAL_API_KEY = "YOUR_MISTRAL_API_KEY"
$env:INVOICE_URL = "https://your-host.example/invoice.pdf"
node extract.mjs
```

Bash 或 zsh：

```sh
export MISTRAL_API_KEY="YOUR_MISTRAL_API_KEY"
export INVOICE_URL="https://your-host.example/invoice.pdf"
node extract.mjs
```

图片使用 `kind: "image"` 和 HTTP(S) 图片 URL。批量提取只需在 `inputs` 中传入多项，无需单独的批量方法。文件可访问性、支持的文档格式及账号限制由 Mistral 判断，不由本地文件检查决定。

在 TypeScript 中，可以使用 `extractStructured<Invoice>(request)` 描述预期的数据类型。它不会校验提取字段；使用结果前仍需执行你的业务校验。

## 配置

| 字段 | 约定 |
|---|---|
| `provider` / `model` | `mistral` / `mistral-ocr-4-1`，不支持 `latest` 别名 |
| `apiKey` | 必填，非空白字符串，须能作为合法 HTTP 请求头值；按原值发送 |
| `timeoutMs` | 必填，有限正整数，单位毫秒，分别作用于每个有效输入 |
| `baseUrl` | 可选，服务根地址；默认 `https://api.mistral.ai` |
| `schema` | 根节点为 `type: "object"` 的普通 JSON 对象；仅做基本可序列化校验 |
| `prompt` | 可选字符串，原样转发 |
| `providerOptions.pages` | 可选，非空的零基安全整数数组，或范围字符串，例如 `0,2-4` |
| `inputs` | 必填，非空的 `{ url, kind, id? }` 数组 |
| `url` | 绝对 HTTP(S) 地址字符串，不含嵌入式用户名或密码 |
| `kind` | `document` 或 `image` |
| `id` | 可选字符串，允许空字符串和重复值 |

不接受其他 Provider 选项。页码不会自动排序、去重或展开。网关前缀如 `https://gateway.example/mistral` 会映射到 `https://gateway.example/mistral/v1/ocr`。`baseUrl` 不应包含操作接口路径、凭据、查询参数或片段。自定义网关会收到你的 API Key 和请求内容。

Schema 必须是普通 JSON 数据。自定义序列化钩子、访问器、稀疏数组和自定义数组原型会在任何请求发起前被拒绝。校验后的值会被复制，过程中不会调用这些钩子。

## 响应与错误

每个输入对应一个结果项，顺序与输入一致。`index` 始终标识原始输入位置；调用方提供的字符串 `id` 会原样返回。缺失或非法的 id 不会被自动生成或强制转换。

无法读取属性的输入会返回 `INVALID_INPUT`，不影响后续输入。无法读取的 id 会被省略，已安全读取的字符串 id 会保留。服务商完整响应中的非法 UTF-8 会产生 `UNKNOWN_PROVIDER_ERROR`，不会悄悄替换业务文本。

```json
{
  "items": [
    {
      "status": "success", "index": 0, "id": "invoice-1",
      "provider": "mistral", "model": "mistral-ocr-4-1",
      "data": { "invoiceNumber": "INV-001", "total": 42 }
    },
    {
      "status": "error", "index": 1,
      "provider": "mistral", "model": "mistral-ocr-4-1",
      "error": { "code": "RATE_LIMITED", "message": "Provider rate limit exceeded.", "providerStatus": 429 }
    }
  ]
}
```

调用级失败会在任何请求发起前以 `ExtractionRuntimeError` 拒绝整次调用，包括：`INVALID_ARGUMENT`、`UNSUPPORTED_PROVIDER`、`UNSUPPORTED_MODEL`、`INVALID_PROVIDER_CONFIG`、`INVALID_SCHEMA`。

| 单项错误 | 含义 |
|---|---|
| `INVALID_INPUT` | URL、kind、id 或输入结构非法；不为该输入发起请求 |
| `NETWORK_ERROR` / `TIMEOUT` | 连接或流失败，或超过本地截止时间 |
| `AUTHENTICATION_FAILED` / `RATE_LIMITED` | HTTP 401/403 或 429 |
| `PROVIDER_REJECTED` | 3xx 或其他 4xx，包括 408/413/415/421 |
| `PROVIDER_RESPONSE_INCOMPLETE` | 服务商明确返回未完成状态并被归一化；当前 Mistral OCR 没有文档定义的完成标志 |
| `STRUCTURED_OUTPUT_MISSING` | annotation 缺失或为 null |
| `STRUCTURED_OUTPUT_INVALID_JSON` | annotation 字符串不是合法 JSON |
| `STRUCTURED_OUTPUT_INVALID_SHAPE` | annotation 解析结果不是非 null、非数组的对象 |
| `UNKNOWN_PROVIDER_ERROR` | 5xx、非法响应外层结构、非字符串 annotation、不支持的编码或其他协议错误 |
| `UNSUPPORTED_FILE` / `FILE_LIMIT_EXCEEDED` | 预留错误码；本版本将 Mistral HTTP 413/415 映射为 `PROVIDER_REJECTED` |

`providerStatus` 可选，仅来源于 HTTP 状态码。`providerRequestId` 是预留字段，本版本不返回。错误使用固定消息，不暴露原始响应、密钥、URL、Schema、prompt 或底层异常。调用方的 `id` 和业务 `data` 不会被脱敏，请避免自行记录其中的敏感值。

## 运行边界

- 一次调用内的输入串行处理；独立调用可重叠执行。输入、配置和 Schema 都在第一次 await 前生成快照。
- 每个有效输入最多尝试一次原生 HTTP 请求。不重试、不跟随重定向、不切换备用模型、不修复结果、不自动续写。单项失败不影响后续项。
- 仅对 `document_annotation` 执行一次解析，得到对象 `data`。不做本地业务 Schema 校验、字段类型转换、默认值填充、置信度或证据核验，也没有 `partial` 状态。泛型只描述预期，不保证数据已通过校验。
- runtime 将文件 URL 发送给服务商，不自行下载文件、不转换 Office 文件；`extractStructured` 不接受本地路径或字节内容。
- 截止时间覆盖单次网络交互、完整响应体和解析检查。到期会销毁本地流。同步 JSON 解析无法被抢占，但超时结果不会判定为成功。本地取消不会撤销服务商处理或费用。
- 上游响应中的 OCR 页与 Markdown 会被接收，但解包后不向调用方暴露或保留其引用。没有响应大小上限；峰值内存包括完整响应、解析临时对象和累计批量数据。

## 本地文本提取

以下 API 已标记为弃用，但仍保持兼容。它们独立于结构化 OCR，不调用 Mistral。

### 使用示例

```ts
import { extract } from "@devcodex-labs/extraction-runtime";

const result = await extract("./README.md");

console.log(result.text);
console.log(result.metadata);
```

### 支持的输入

- 本地文件路径
- 指向本地文件的 `URL` 对象
- `Buffer`、`Uint8Array` 和 `ArrayBuffer`
- Node.js 可读流

### 内置解析器

- 纯文本：`.txt`
- Markdown：`.md`、`.markdown`
- JSON：`.json`
- CSV：`.csv`
- HTML：`.html`、`.htm`

### 函数

#### `extract(input, options)`

从文件类输入中提取文本、元数据和结构化片段。

```ts
const result = await extract(buffer, {
  filename: "data.json",
  mimeType: "application/json"
});
```

#### `detectFileType(input, options)`

根据文件名、MIME 类型和轻量内容探测推断文件类型。

#### `registerParser(parser)`

在运行时注册解析器。

```ts
import { registerParser } from "@devcodex-labs/extraction-runtime";

registerParser({
  id: "custom",
  extensions: [".custom"],
  async parse(context) {
    return {
      text: context.content.toString("utf8"),
      metadata: {},
      sections: [],
      pages: [],
      warnings: [],
      source: context.source
    };
  }
});
```
