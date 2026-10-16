---
name: llm-structured-outputs
description: "Cross-provider reference for LLM structured outputs with Claude 5.5 (Opus 5.5 / Sonnet 5.5 / Haiku 5.5) + Opus 4.8 (security) + Fable 5.1, OpenAI GPT-6 / 6.1 (Astra / 6.1 Sol / Luna), Gemini 4 Argon / 3.8 Flash, DeepSeek V4 Pro / V4.1 Flash, and Grok 4.7. Use when implementing json_schema constrained decoding, writing Zod 4 schemas for LLM APIs, building multi-provider abstractions, or debugging schema compliance failures."
---

# LLM Structured Outputs

Cross-provider reference for schema-constrained JSON decoding with all major frontier LLM APIs. Last updated: October 16, 2026.

## When to Use This Skill

- Implementing structured LLM outputs with any major frontier provider
- Choosing the right API field for `json_schema` per vendor
- Writing Zod 4 schemas and converting them via native `z.toJSONSchema()`
- Building provider-agnostic LLM abstraction layers across Anthropic, OpenAI, Google, DeepSeek, and xAI
- Debugging parse failures, reasoning-token truncation, or schema non-compliance

---

## Core Concept

All five frontier providers support **constrained decoding**: you send a JSON Schema and the model is constrained at the token level to produce compliant JSON.

| Provider                                         | Flagship Models (Oct 2026)                                       | API Field                             | Type Value          |
| ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------- | ------------------- |
| Anthropic Claude 5.5 / 4.8 (security)            | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-4-8`, `claude-fable-5-1` | `output_config.format` | `"json_schema"` |
| OpenAI GPT-6 / 6.1 (Responses API)               | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`                       | `text.format`                         | `"json_schema"`     |
| OpenAI GPT-6 / 6.1 (Chat Completions)            | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`                       | `response_format`                     | `"json_schema"`     |
| Google Gemini 4 Argon / 3.8 Flash                | `gemini-4-argon`, `gemini-3.8-flash`                             | `generationConfig.responseJsonSchema` | N/A (schema object) |
| DeepSeek V4 / V4.1                               | `deepseek-v4-pro`, `deepseek-flash`                              | `response_format`                     | `"json_schema"`     |
| xAI Grok 4.7                                     | `grok-4.7`, `grok-4.7-build-fast`                                | `response_format`                     | `"json_schema"`     |

---

## Per-Vendor API Patterns

### Anthropic Claude 5.5 (`claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`) & Opus 4.8 (Security)

```typescript
const response = await anthropic.messages.create({
  model: "claude-sonnet-5-5", // or "claude-opus-5-5", "claude-haiku-5-5", "claude-opus-4-8" (security), "claude-fable-5-1"
  max_tokens: 4096,
  messages: [{ role: "user", content: prompt }],
  output_config: {
    format: {
      type: "json_schema",
      schema: jsonSchema,
    },
  },
});
const parsed = JSON.parse(response.content[0].text);
```

Key facts:

- Use `output_config: { format: { type: "json_schema", schema } }` (the legacy beta `output_format` field is removed)
- Assistant prefilling (`role: "assistant"` in messages) is unsupported and returns 400
- Optional fields via `"type": ["string", "null"]` unions
- **NOT supported:** `anyOf`, `oneOf`, `allOf`, `pattern`, min/max constraints, recursive schemas

### OpenAI GPT-6 / 6.1 (`gpt-6-astra` / `gpt-6.1-sol` / `gpt-6-luna`)

**Responses API** (recommended):

```typescript
const response = await openai.responses.create({
  model: "gpt-6.1-sol", // "gpt-6-astra" for premier flagship reasoning; "gpt-6-luna" for low-latency / high-throughput
  input: prompt,
  text: {
    format: {
      type: "json_schema",
      json_schema: { name: "result", strict: true, schema: jsonSchema },
    },
  },
});
```

**Chat Completions API** (legacy):

```typescript
const response = await openai.chat.completions.create({
  model: "gpt-6.1-sol",
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "result", strict: true, schema: jsonSchema },
  },
});
```

- **Supported:** `anyOf`, `pattern`, `minimum`/`maximum`, `enum`
- **NOT supported:** `oneOf`, `allOf`, recursive schemas
- `additionalProperties: false` and all fields listed in `required` (or `null`-unioned) are mandatory

### Google Gemini 4 Argon & 3.8 Flash (`gemini-4-argon` / `gemini-3.8-flash`)

```typescript
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-4-argon", // or "gemini-3.8-flash" for low-latency / high-throughput
  contents: prompt,
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: jsonSchema,
  },
});
const parsed = JSON.parse(response.text);
```

- Broadest schema support: `anyOf`, `$ref` (recursive), `prefixItems`, `minimum`/`maximum`, `pattern`
- **NOT supported:** `allOf`, `oneOf`, `not`, `if`/`then`/`else`

### DeepSeek V4 Pro & V4.1 Flash (`deepseek-v4-pro` / `deepseek-flash`)

```typescript
import OpenAI from "openai";
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});

const response = await deepseek.chat.completions.create({
  model: "deepseek-v4-pro", // or "deepseek-flash" (DeepSeek V4.1 Flash)
  max_tokens: 8192, // Include headroom for reasoning_content + JSON output
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "result", strict: true, schema: jsonSchema },
  },
});
const parsed = JSON.parse(response.choices[0].message.content);
```

- **Reasoning token headroom:** `deepseek-v4-pro` emits chain-of-thought in `message.reasoning_content` before writing constrained JSON to `message.content`. Always budget `max_tokens >= 8192` so reasoning does not truncate the JSON payload.
- Requires `additionalProperties: false` and all properties in `required`.

### xAI Grok 4.7 (`grok-4.7` / `grok-4.7-build-fast`)

```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

const response = await client.chat.completions.create({
  model: "grok-4.7", // or "grok-4.7-build-fast"
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "result", strict: true, schema: jsonSchema },
  },
});
const parsed = JSON.parse(response.choices[0].message.content);
```

---

## Cross-Provider Feature Matrix

| Feature                       | Claude 5.5 / Opus 4.8 | GPT-6 / 6.1 (`astra`/`6.1-sol`/`luna`) | Gemini 4 Argon / 3.8 Flash | DeepSeek V4 / V4.1 |   Grok 4.7    |
| ----------------------------- | :-------------------: | :------------------------------------: | :------------------------: | :----------------: | :-----------: |
| `anyOf`                       |          ❌           |                   ✅                   |             ✅             |         ✅         | ⚠️ flat only  |
| `$ref` (recursive)            |     internal only     |                limited                 |             ✅             |         ❌         |      ❌       |
| `pattern`                     |          ❌           |                   ✅                   |             ✅             |         ❌         |      ❌       |
| min/max constraints           |          ❌           |                   ✅                   |             ✅             |         ❌         |      ❌       |
| `additionalProperties: false` |       required        |                required                |         supported          |      required      |   supported   |
| Constrained decoding status   |          GA           |                   GA                   |             GA             |         GA         |      GA       |

---

## Zod 4 Integration (Native `z.toJSONSchema()`)

`zod-to-json-schema` is retired. Use Zod 4's built-in `z.toJSONSchema()`:

```typescript
import { z } from "zod";

const MySchema = z
  .object({
    title: z.string(),
    score: z.number(),
    tags: z.array(z.string()),
    status: z.enum(["active", "archived"]),
  })
  .strict();

const jsonSchema = z.toJSONSchema(MySchema);
```

### SDK Helpers

```typescript
// OpenAI Responses API (GPT-6 / 6.1)
import { zodTextFormat } from "openai/helpers/zod";
text: { format: zodTextFormat(MySchema, "result") }

// OpenAI Chat Completions / DeepSeek V4 / Grok 4.7
import { zodResponseFormat } from "openai/helpers/zod";
response_format: zodResponseFormat(MySchema, "result")

// Anthropic SDK parse helper (Claude 5.5 / Opus 4.8)
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
const response = await anthropic.messages.parse({
  model: "claude-sonnet-5-5",
  max_tokens: 4096,
  messages: [{ role: "user", content: prompt }],
  output_config: { format: zodOutputFormat(MySchema, "result") },
});
const result = response.parsed_output;
```

---

## References

- [Full provider details](./references/provider-details.md) — per-vendor model IDs, limits, schema subsets, and edge cases
