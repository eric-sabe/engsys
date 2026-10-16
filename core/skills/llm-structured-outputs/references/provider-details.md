# LLM Structured Outputs — Provider Details

> Detailed per-provider reference. See [SKILL.md](../SKILL.md) for the quick-start guide.
> Last updated: October 15, 2026.

---

## Anthropic Claude Sonnet 5 / Opus 4.8

**Model IDs:** `claude-sonnet-5` · `claude-opus-4-8` (also legacy `claude-opus-4-6` / `claude-sonnet-4-6`)
**Context window:** 500K–1M tokens
**Max output tokens:** 128K (`claude-opus-4-8`), 64K (`claude-sonnet-5`)
**Structured outputs status:** Generally available (GA) — no beta header required

### API parameter: `output_config.format`

The API parameter is `output_config.format` (`output_config: { format: { type: "json_schema", schema } }`). Never use the retired beta parameter name.

```typescript
// TypeScript — direct API call
const response = await anthropic.messages.create({
  model: "claude-sonnet-5", // or "claude-opus-4-8"
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

// TypeScript — using SDK .parse() helper
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
const response = await anthropic.messages.parse({
  model: "claude-opus-4-8",
  max_tokens: 4096,
  messages: [{ role: "user", content: prompt }],
  output_config: {
    format: zodOutputFormat(MySchema, "result"),
  },
});
const result = response.parsed_output;
```

### Strict tool use

```typescript
tools: [
  {
    name: "extract_data",
    description: "Extract structured data",
    strict: true,
    input_schema: {
      type: "object",
      properties: { /* ... */ },
      required: [ /* ... */ ],
      additionalProperties: false,
    },
  },
];
```

### Supported JSON Schema subset

- **Supported:** `type`, `properties`, `required`, `additionalProperties: false`, `enum`, `const`, `items`, nested objects, arrays, `string`, `number`, `integer`, `boolean`, `null`, `$ref` (internal definitions only).
- **NOT supported:** `anyOf`, `oneOf`, `allOf` (top-level), `pattern`, `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`, `prefixItems`, recursive schemas.
- Optional fields are expressed via `"type": ["string", "null"]` unions.

---

## OpenAI GPT-5.6 (`gpt-5.6-terra` / `gpt-5.6-sol`)

**Model IDs:** `gpt-5.6-terra` (deep reasoning & complex synthesis) · `gpt-5.6-sol` (high-speed execution & tool use)
**Structured outputs status:** GA via both Responses API and Chat Completions API

### Responses API (recommended)

```typescript
const response = await openai.responses.create({
  model: "gpt-5.6-terra",
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

### Supported JSON Schema subset

- **Supported:** `string`, `number`, `integer`, `boolean`, `object`, `array`, `enum`, `anyOf`, `pattern`, `format`, `minimum`/`maximum`, `additionalProperties: false` (mandatory).
- **NOT supported:** `oneOf`, `allOf`, recursive schemas.
- Root schema must be `type: "object"`, and every property must be listed in `required` (use `["string", "null"]` for nullable fields).

---

## Google Gemini 3.1 Pro

**Model ID:** `gemini-3.1-pro`
**Context window:** 2M tokens input · 64K tokens output
**Structured outputs status:** GA with constrained decoding

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-3.1-pro",
  contents: prompt,
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: jsonSchema,
  },
});
const parsed = JSON.parse(response.text);
```

- **Supported:** `type`, `properties`, `required`, `enum`, `items`, `additionalProperties`, `anyOf`, `$ref` (recursive schemas), `prefixItems` (tuples), `minimum`/`maximum`, `minItems`/`maxItems`, `pattern`.
- **NOT supported:** `allOf`, `oneOf`, `not`, `if`/`then`/`else`.

---

## DeepSeek V4 (`deepseek-v4-pro` / `deepseek-v4-flash`)

**Model IDs:** `deepseek-v4-pro` (frontier reasoning + coding) · `deepseek-v4-flash` (low-latency structured extraction)
**Context window:** 256K tokens
**OpenAI-compatible API:** Yes — base URL `https://api.deepseek.com/v1`

```typescript
import OpenAI from "openai";

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});

const response = await deepseek.chat.completions.create({
  model: "deepseek-v4-pro",
  max_tokens: 8192,
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
```

### Caveats for DeepSeek V4 Structured Outputs

1. **Reasoning token budget:** `deepseek-v4-pro` generates `reasoning_content` tokens before emitting the constrained JSON string in `content`. Both count toward `max_tokens`. Always set `max_tokens >= 8192` and check `finish_reason !== "length"` before calling `JSON.parse`.
2. **Strict schema rules:** Every object must set `additionalProperties: false` and include all keys in `required`.
3. **Avoid regex `pattern` and numerical bounds in schema:** Validate `min`/`max` and regex constraints downstream with `MyZodSchema.parse()`.

---

## xAI Grok 4.5 (`grok-4.5` / `grok-4.5-reasoning`)

**Model IDs:** `grok-4.5` · `grok-4.5-reasoning`
**Context window:** 1M tokens
**OpenAI-compatible API:** Yes — base URL `https://api.x.ai/v1`

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

const response = await client.chat.completions.create({
  model: "grok-4.5-reasoning",
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
```

---

## Zod 4 Native JSON Schema

Use Zod 4's built-in `z.toJSONSchema()`:

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

const jsonSchema = z.toJSONSchema(MySchema, { target: "draft-07" });
```
