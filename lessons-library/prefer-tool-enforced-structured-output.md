# Prefer tool-enforced structured output

**Trigger:** You're relying on prompt instructions to make a model produce a specific format, or letting a pipeline proceed on an unknown model/config.

**Failure mode:** "Please respond as JSON" is policed by the model's goodwill — it drifts, adds prose, or breaks downstream parsing. Pipelines that silently accept unknown/unpriced models or configs fail unpredictably or rack up surprise cost.

**Correct behavior:**
- Use schema/tool-enforced structured output (e.g. tool-use / function calling / response schemas) instead of prompt-policed formatting.
- Treat formatting instructions as fragile; enforced structure as reliable.
- Guard pipelines to refuse to proceed on unknown/unpriced models or configs.
- Fail loud on a config you can't validate, rather than guessing.

**Check:** If the model ignored every formatting instruction, would the output still parse?

**Seen in:** recurring across multiple production projects.
