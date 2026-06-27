---
name: llm-structured-outputs
description: "Cross-provider reference for LLM structured outputs with Claude 4.6, GPT-5.3, Gemini 3.1 Pro, and Grok 4. Use when implementing json_schema constrained decoding, writing Zod schemas for LLM APIs, building multi-provider abstractions, or debugging schema compliance failures."
---

# LLM Structured Outputs

Cross-provider reference for schema-constrained JSON decoding with all major frontier LLM APIs. Last updated: February 23, 2026.

## When to Use This Skill

- Implementing structured LLM outputs with any major provider
- Choosing the right API field for `json_schema` per vendor
- Writing Zod schemas and converting them to JSON Schema for API requests
- Building provider-agnostic LLM abstraction layers
- Debugging parse failures or schema non-compliance
- Migrating off `zod-to-json-schema` (deprecated Nov 2025)
- Handling edge cases: truncation, refusals, cache invalidation

---

## Core Concept

All four providers support **constrained decoding**: you send a JSON Schema and the model is constrained at the token level to produce compliant JSON. This is mathematical, not probabilistic.

| Provider                          | API Field                             | Type Value          |
| --------------------------------- | ------------------------------------- | ------------------- |
| Anthropic Claude 4.6              | `output_config.format`                | `"json_schema"`     |
| OpenAI GPT-5.3 (Responses API)    | `text.format`                         | `"json_schema"`     |
| OpenAI GPT-5.3 (Chat Completions) | `response_format`                     | `"json_schema"`     |
| Gemini 3.1 Pro                    | `generationConfig.responseJsonSchema` | N/A (schema object) |
| xAI Grok 4                        | `response_format`                     | `"json_schema"`     |

---

## Per-Vendor API Patterns

### Anthropic Claude 4.6 (GA — no beta header needed)

```typescript
const response = await anthropic.messages.create({
  model: "claude-opus-4-6", // or 'claude-sonnet-4-6'
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

- GA since Feb 4, 2026 — **no** `anthropic-beta` header required
- `output_config.format` replaces deprecated `output_format`
- Assistant prefilling (`role: "assistant"` in messages) removed — returns 400
- Optional fields via `"type": ["string", "null"]` unions
- **NOT supported:** `anyOf`, `oneOf`, `allOf`, `pattern`, min/max constraints, recursive schemas

### OpenAI GPT-5.3

**Responses API** (recommended):

```typescript
const response = await openai.responses.create({
  model: "gpt-5.3",
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
  model: "gpt-5.3",
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "result", strict: true, schema: jsonSchema },
  },
});
```

> **Warning:** `gpt-5.3-chat-latest` does **not** support `json_schema`. Use `gpt-5.3` or `gpt-5.3-pro`.

- **Supported:** `anyOf`, `pattern`, `minimum`/`maximum`, `enum`
- **NOT supported:** `oneOf`, `allOf`, recursive schemas
- `additionalProperties: false` and all fields `required` (or `null`-unioned) are mandatory

### Gemini 3.1 Pro

```typescript
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
```

- **Broadest schema support** of all four providers
- Supports `anyOf`, `$ref` (recursive), `prefixItems`, `minimum`/`maximum`, `pattern`
- **NOT supported:** `allOf`, `oneOf`, `not`, `if`/`then`/`else`
- Enum-only mode: `responseMimeType: 'text/x.enum'`
- Always strict (implicit constrained decoding)

### xAI Grok 4

```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

const response = await client.chat.completions.create({
  model: "grok-4-1-fast-reasoning", // recommended for production
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "result", strict: true, schema: jsonSchema },
  },
});
const parsed = JSON.parse(response.choices[0].message.content);
```

- OpenAI SDK works directly (same API shape)
- **NOT supported / unreliable:** min/max constraints, `pattern`, `allOf` — validate downstream
- Prefer `grok-4-1-fast-reasoning` over `grok-4-0709` (known strict mode empty-response bug)

---

## Cross-Provider Feature Matrix

| Feature                       |  Claude 4.6   | GPT-5.3  | Gemini 3.1 Pro |    Grok 4     |
| ----------------------------- | :-----------: | :------: | :------------: | :-----------: |
| `anyOf`                       |      ❌       |    ✅    |       ✅       | ⚠️ unreliable |
| `$ref` (recursive)            | internal only | limited  |       ✅       |      ❌       |
| `pattern`                     |      ❌       |    ✅    |       ✅       |      ❌       |
| min/max constraints           |      ❌       |    ✅    |       ✅       |      ❌       |
| `additionalProperties: false` |   required    | required |   supported    |   supported   |
| Constrained decoding status   |      GA       |    GA    |       GA       |      GA       |

---

## Safe Cross-Provider Schema Subset

Use this when schemas must work across **all four** providers:

```typescript
{
  type: 'object',
  properties: {
    name:    { type: 'string' },
    count:   { type: 'integer' },
    score:   { type: 'number' },
    active:  { type: 'boolean' },
    status:  { type: 'string', enum: ['pending', 'done', 'failed'] },
    tags:    { type: 'array', items: { type: 'string' } },
    nested:  {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    }
  },
  required: ['name', 'count', 'score', 'active', 'status', 'tags', 'nested'],
  additionalProperties: false
}
```

**Avoid in cross-provider schemas:** `anyOf`, `oneOf`, `allOf`, `$ref`, `pattern`, min/max, `prefixItems`, `const`, `not`.

---

## Zod 4 Integration (Native JSON Schema)

`zod-to-json-schema` is **deprecated as of November 2025**. Use Zod 4's built-in `z.toJSONSchema()`:

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

// Native Zod 4 — no external dependency
const jsonSchema = z.toJSONSchema(MySchema);

// Optional: target specific draft
z.toJSONSchema(MySchema, { target: "draft-07" });
```

### Zod SDK Helpers

```typescript
// OpenAI Responses API
import { zodTextFormat } from "openai/helpers/zod";
text: {
  format: zodTextFormat(MySchema, "result");
}

// OpenAI Chat Completions / Grok
import { zodResponseFormat } from "openai/helpers/zod";
response_format: zodResponseFormat(MySchema, "result");

// Anthropic SDK parse helper
const response = await anthropic.messages.parse({
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  messages: [{ role: "user", content: prompt }],
  output_format: MySchema, // SDK converts automatically
});
const result = response.parsed_output;
```

---

## Multi-Provider Abstraction Pattern

```typescript
import { z } from "zod";

const MySchema = z
  .object({
    /* fields */
  })
  .strict();
const jsonSchema = z.toJSONSchema(MySchema);

// Anthropic
const anthropicBody = {
  output_config: { format: { type: "json_schema", schema: jsonSchema } },
};

// OpenAI (Responses API)
const openaiBody = {
  text: {
    format: {
      type: "json_schema",
      json_schema: { name: "result", strict: true, schema: jsonSchema },
    },
  },
};

// OpenAI (Chat Completions) / Grok
const openaiChatBody = {
  response_format: {
    type: "json_schema",
    json_schema: { name: "result", strict: true, schema: jsonSchema },
  },
};

// Gemini
const geminiConfig = {
  responseMimeType: "application/json",
  responseJsonSchema: jsonSchema,
};

// Always validate output regardless of provider
function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): T {
  const json = JSON.parse(raw);
  return schema.parse(json); // throws ZodError on mismatch
}
```

---

## Edge Cases & Troubleshooting

| Issue                           | Cause                                                   | Fix                                          |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Anthropic returns 400           | Assistant prefilling used                               | Remove `role: "assistant"` from messages     |
| Anthropic ignores schema        | Using `output_format` instead of `output_config.format` | Update parameter name                        |
| GPT-5.3 rejects `json_schema`   | Using `gpt-5.3-chat-latest`                             | Switch to `gpt-5.3` or `gpt-5.3-pro`         |
| Grok returns empty response     | `grok-4-0709` + complex `strict: true` schema           | Switch to `grok-4-1-fast-reasoning`          |
| JSON incomplete / truncated     | `stop_reason: "max_tokens"`                             | Increase `max_tokens` or simplify prompt     |
| Refusal / no output             | Safety system triggered                                 | Check `stop_reason`, add context or rephrase |
| Prompt cache miss               | `output_config.format` changed                          | Keep schema constant across turns            |
| Zod import error `toJSONSchema` | Zod v3 still installed                                  | Upgrade to Zod 4 (`zod@^4`)                  |

---

## Best Practices

1. **Always use constrained decoding** — never rely on prompt-only JSON formatting
2. **Define schemas in Zod, derive JSON Schema** via `z.toJSONSchema()` — single source of truth
3. **Always validate outputs** through `schema.parse()` even with constrained decoding
4. **Handle truncation**: check `stop_reason === "max_tokens"` before parsing
5. **Keep schemas flat and explicit** for cross-provider reliability
6. **Use `additionalProperties: false`** and list all fields in `required` on every object
7. **Implement a retry/repair loop**: on `ZodError`, retry with the invalid JSON + error message as context

---

## References

- [Full provider details](./references/provider-details.md) — per-vendor model IDs, limits, schema subsets, and docs
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs/)
- [Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Grok Structured Outputs](https://docs.x.ai/docs/guides/structured-outputs)
- [Zod 4 JSON Schema](https://zod.dev/json-schema)
