# LLM Structured Outputs — Provider Details

> Detailed per-provider reference. See [SKILL.md](../SKILL.md) for the quick-start guide.
> Last updated: February 23, 2026.

---

## Anthropic Claude Opus 4.6 / Sonnet 4.6

**Model IDs:** `claude-opus-4-6` · `claude-sonnet-4-6`
**Context window:** 200K tokens (1M available in beta with header `context-1m-2025-08-07`)
**Max output tokens:** 128K (Opus 4.6), 64K (Sonnet 4.6)
**Structured outputs status:** Generally available (GA) — no beta header required

### API parameter: `output_config.format`

Structured outputs graduated from beta to GA on February 4, 2026. The API parameter is `output_config.format` (replacing the deprecated `output_format` from the beta period).

```typescript
// TypeScript — direct API call
const response = await anthropic.messages.create({
  model: "claude-opus-4-6", // or 'claude-sonnet-4-6'
  max_tokens: 4096,
  messages: [{ role: "user", content: prompt }],
  output_config: {
    format: {
      type: "json_schema",
      schema: jsonSchema, // JSON Schema object
    },
  },
});
const parsed = JSON.parse(response.content[0].text);

// TypeScript — using SDK .parse() helper
const response = await anthropic.messages.parse({
  model: "claude-opus-4-6",
  max_tokens: 4096,
  messages: [{ role: "user", content: prompt }],
  output_format: MySchema, // SDK converts to JSON Schema automatically
});
const result = response.parsed_output; // Already validated
```

### Strict tool use

```typescript
tools: [
  {
    name: "extract_data",
    description: "Extract structured data",
    strict: true, // Constrained decoding for tool args
    input_schema: {
      type: "object",
      properties: {
        /* ... */
      },
      required: [
        /* ... */
      ],
      additionalProperties: false,
    },
  },
];
```

### Supported JSON Schema subset

**Supported:** `type`, `properties`, `required`, `additionalProperties`, `enum`, `const`, `items`, nested objects, arrays, `string`, `number`, `integer`, `boolean`, `null`, `$ref` (internal definitions only).

**NOT supported:** `anyOf`, `oneOf`, `allOf` (top-level), `pattern`, `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`, `prefixItems`, `$dynamicRef`, recursive schemas.

**Complexity limits (per request):**

- Max 20 strict tools
- Max 24 optional parameters (across all strict schemas)
- Max 16 parameters with union types (e.g., `"type": ["string", "null"]`)

Optional fields are emulated via `"type": ["string", "null"]` unions (counts toward the union type limit).

### Breaking changes from Claude 4.5

1. **Parameter renamed:** `output_format` → `output_config.format` (old name still works during transition)
2. **Beta header removed:** `anthropic-beta: structured-outputs-2025-11-13` is no longer needed
3. **Assistant prefilling removed:** Starting assistant messages with `{"role": "assistant"}` now returns 400. Use structured outputs or system prompts instead.
4. **Adaptive thinking:** `thinking.type: "adaptive"` replaces `thinking.type: "enabled"` with `budget_tokens`

### Edge cases

- **Refusals:** Check `stop_reason` field — model may refuse for safety reasons
- **Truncation:** `stop_reason: "max_tokens"` means JSON may be incomplete
- **Cache invalidation:** Changing `output_config.format` invalidates prompt cache for that conversation

**Docs:** https://platform.claude.com/docs/en/build-with-claude/structured-outputs
**Models:** https://platform.claude.com/docs/en/about-claude/models/overview
**Release notes:** https://www.anthropic.com/news/claude-opus-4-6

---

## OpenAI GPT-5.3

**Model IDs:** `gpt-5.3` (primary) · `gpt-5.3-pro` (premium) · `gpt-5.3-chat-latest` (conversational — ⚠️ **no** `json_schema` support)
**Structured outputs status:** GA via both Responses API and Chat Completions API

### Two API surfaces

**Responses API** (recommended for new code):

```typescript
const response = await openai.responses.create({
  model: "gpt-5.3",
  input: prompt,
  text: {
    format: {
      type: "json_schema",
      json_schema: {
        name: "artifacts",
        strict: true,
        schema: jsonSchema,
      },
    },
  },
  reasoning: { effort: "high" }, // none | low | medium | high | xhigh
});
```

**Chat Completions API** (legacy, still supported):

```typescript
const response = await openai.chat.completions.create({
  model: "gpt-5.3",
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "artifacts",
      strict: true,
      schema: jsonSchema,
    },
  },
});
```

### Structured Outputs vs JSON mode

| Feature               | Structured Outputs    | JSON Mode                     |
| --------------------- | --------------------- | ----------------------------- |
| API field             | `type: "json_schema"` | `type: "json_object"`         |
| Schema enforcement    | Constrained decoding  | None — only valid JSON syntax |
| Field/type guarantees | Schema-compliant      | No guarantees                 |
| Recommendation        | **Use this**          | Legacy fallback only          |

### Supported JSON Schema subset

**Supported:** `string`, `number`, `integer`, `boolean`, `object`, `array`, `enum`, `anyOf`, `pattern`, `format`, range constraints (`minimum`, `maximum`), `additionalProperties: false` (required).

**NOT supported:** `oneOf`, `allOf`, complex conditional schemas, recursive schemas.

**Requirements:** Root schema must be `type: "object"`. All fields must be `required` or unioned with `null`. `additionalProperties: false` mandatory.

### SDK helpers

```typescript
import { zodTextFormat } from "openai/helpers/zod";

const response = await openai.responses.create({
  model: "gpt-5.3",
  input: prompt,
  text: { format: zodTextFormat(MyZodSchema, "artifacts") },
});
// Response is auto-parsed via Zod

import { zodResponseFormat } from "openai/helpers/zod";
response_format: zodResponseFormat(MyZodSchema, "artifacts");
```

### Notable GPT-5.3 features

- **~40% faster inference** than GPT-5.1 (Feb 2026 optimization)
- **Reasoning effort levels:** `none`, `low`, `medium`, `high`, `xhigh`
- **Context compaction:** Automatic context management for long-context extraction
- **Chain of thought:** Responses API preserves reasoning chains across turns

**Docs:** https://developers.openai.com/api/docs/guides/structured-outputs/
**Migration to Responses API:** https://developers.openai.com/api/docs/guides/migrate-to-responses/

---

## Google Gemini 3.1 Pro

**Model ID:** `gemini-3.1-pro-preview`
**Context window:** 1M tokens input · 64K tokens output
**Structured outputs status:** GA with constrained decoding

### API parameter: `generationConfig`

```typescript
// TypeScript — Google AI SDK (@google/genai)
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-3.1-pro-preview",
  contents: prompt,
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: jsonSchema,
  },
});
const parsed = JSON.parse(response.text);

// TypeScript — REST API (camelCase required)
body: JSON.stringify({
  contents: [{ role: "user", parts: [{ text: prompt }] }],
  generationConfig: {
    responseMimeType: "application/json",
    responseJsonSchema: jsonSchema,
  },
});
```

> **SDK naming:** Python SDK uses `response_mime_type` / `response_json_schema` (snake_case, auto-converted). TypeScript SDK uses camelCase directly.

### Supported JSON Schema subset

Gemini 3.1 Pro has the **broadest** JSON Schema support of all four providers:

**Supported:** `type`, `properties`, `required`, `enum`, `items`, `additionalProperties`, `anyOf`, `$ref` (recursive schemas), `prefixItems` (tuples), `minimum`/`maximum`, `minItems`/`maxItems`, `pattern` (regex), `type: 'null'`.

**NOT supported:** `allOf`, `oneOf`, `not`, `patternProperties`, `if`/`then`/`else`, `const` (limited).

**New in Gemini 3.1 Pro** (vs Gemini 3 Pro): `anyOf`, `$ref`, `minimum`/`maximum`, `additionalProperties`, `prefixItems`, implicit property ordering (output keys match schema declaration order).

### Enum responses

For classification:

```typescript
config: {
  responseMimeType: 'text/x.enum',
  responseJsonSchema: {
    type: 'string',
    enum: ['positive', 'negative', 'neutral']
  }
}
// Response is exactly one of the enum values
```

### Function calling

```typescript
tools: [
  {
    functionDeclarations: [
      {
        name: "search_database",
        description: "Search the product database",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      },
    ],
  },
];
```

### Thinking levels

Gemini 3.1 Pro supports `LOW`, `MEDIUM`, `HIGH` thinking levels, combinable with structured outputs.

**Docs:** https://ai.google.dev/gemini-api/docs/structured-output
**Function calling:** https://ai.google.dev/gemini-api/docs/function-calling
**Vertex AI:** https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output

---

## xAI Grok 4

**Model IDs:** `grok-4` / `grok-4-0709` (standard) · `grok-4-1-fast-reasoning` / `grok-4-1-fast-non-reasoning` (recommended)
**Context window:** 256K tokens (Grok 4) · 2M tokens (Grok 4.1 Fast)
**OpenAI-compatible API:** Yes — base URL `https://api.x.ai/v1`

### API: OpenAI-compatible `response_format`

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

const response = await client.chat.completions.create({
  model: "grok-4-1-fast-reasoning",
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "artifacts",
      strict: true,
      schema: jsonSchema,
    },
  },
});
const parsed = JSON.parse(response.choices[0].message.content);

// zodResponseFormat also works directly
import { zodResponseFormat } from "openai/helpers/zod";
response_format: zodResponseFormat(MyZodSchema, "artifacts");
```

### Supported JSON Schema subset

**Supported:** `string`, `number`, `integer`, `float`, `object`, `array`, `boolean`, `enum`, `anyOf`, `required`, `additionalProperties`, `description`.

**NOT supported / unreliable:** `minLength`, `maxLength`, `minItems`, `maxItems`, `allOf`, `pattern`, `minimum`/`maximum`. Enforce these in downstream Zod validation instead.

### Model variant selection

| Variant                       | Use Case                         |         Structured Output          |
| ----------------------------- | -------------------------------- | :--------------------------------: |
| `grok-4` / `grok-4-latest`    | General-purpose                  |                Full                |
| `grok-4-1-fast-reasoning`     | Deep analysis + chain-of-thought |              Full ✅               |
| `grok-4-1-fast-non-reasoning` | Low-latency, high-throughput     |                Full                |
| `grok-4-0709`                 | Legacy                           | ⚠️ Bug with complex strict schemas |

### Strict mode caveats

- `strict: true` provides constrained decoding for supported schema types
- `grok-4-0709` has known empty-response bug with complex `strict: true` schemas — prefer `grok-4-1-fast-*`
- Complex `anyOf`/`oneOf` reduces compliance even in strict mode
- Keep schemas flat and explicit

### Rate limits & pricing

- 480 req/min, 2M tokens/min (Grok 4)
- Cached token pricing: ~75% of regular input pricing

**Docs:** https://docs.x.ai/docs/guides/structured-outputs
**Models:** https://docs.x.ai/docs/models/grok-4-0709

---

## Zod 4 Native JSON Schema

`zod-to-json-schema` was deprecated November 2025. Zod 4 includes native `z.toJSONSchema()`.

```typescript
import { z } from "zod";

const MySchema = z
  .object({
    title: z.string(),
    score: z.number(),
    status: z.enum(["active", "archived"]),
    tags: z.array(z.string()),
  })
  .strict();

const jsonSchema = z.toJSONSchema(MySchema);
// => { type: 'object', properties: {...}, required: [...], additionalProperties: false }

// With options
z.toJSONSchema(MySchema, { target: "draft-07" });
```

### `toJSONSchema` options

```typescript
interface ToJSONSchemaParams {
  target?: "draft-04" | "draft-07" | "draft-2020-12" | "openapi-3.0";
  unrepresentable?: "throw" | "any";
  cycles?: "ref" | "throw";
  reused?: "ref" | "inline";
  uri?: (id: string) => string;
}
```

**Upgrade:** install `zod@^4` then replace all `zod-to-json-schema` imports with `z.toJSONSchema()`.

---

## Additional Resources

- [Azure OpenAI Structured Outputs](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs)
- [AWS Bedrock Structured Outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
- [Anthropic Agent SDK — Structured Outputs](https://platform.claude.com/docs/en/agent-sdk/structured-outputs)
