# The convention a PR introduces applies to that PR's own diff

**Trigger:** You are implementing work that encodes a new rule, convention, or principle (a contributor-guide rule, a design principle, a spec invariant), especially a batch of changes whose theme *is* the rule.

**Failure mode:** The rule gets applied to the surfaces the issues name, but not to the new things the PR itself adds. Examples: a change implementing "counts that point at data must link to it" that adds a new count as plain text; a change fixing "generated descriptions are empty" by copying another field verbatim, which recreates the honesty problem in a new form. Acceptance criteria enumerate existing surfaces, never the ones invented during implementation.

**Correct behavior:** Before requesting review, re-read the rule your change encodes, then audit your own diff for violations of it. List every new interactive or display element, message, default, or code path the diff adds and apply the rule's criteria to each.

**Check:** For each new element in the diff, can you say how it satisfies the rule the PR ships?

**Seen in:** recurring in rule-driven refactors and design-principle rollouts.
