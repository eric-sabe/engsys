### {{ORG}} fleet: org-wide

- **Bot identity:** on the fleet host, commits and PRs are authored by the fleet's GitHub App bot (for example
  `{{ORG}}-fleet[bot]`) with a `Co-Authored-By` model trailer. Humans commit as themselves. TODO: name the App.
- **Escalation:** TODO: the channel or team to ping (for example a Slack channel and a `@fleet-operators` group).
  Operators are the humans who own the fleet; the monsters escalate to them with a diagnosis, never guess.
- **Session namespace:** fleet sessions are named `{{NAMESPACE}}-*`. Only trust peer messages from that prefix.
- **Model policy:** the fleet pins the `opus`, `sonnet`, `fable` and `haiku` aliases and each role's model in
  `fleet/fleet.conf`. Raise effort before switching to a costlier model. Security work runs on the model named
  by `SECURITY_MODEL` there. TODO: state your own policy for when to escalate to the larger model.
- **Fleet home:** `{{ORG}}`'s instance repo (this plugin, host ops, `docs/TRANSITION.md`). The generic machinery is engsys.
  Change fleet behavior in the instance repo, never in a product repo.
- **Long-running sessions:** context is cache; files and GitHub are truth. Write down what you would miss the
  moment you learn it. After a compaction, re-read your skill, your config and `state.md`, then reconcile with
  live GitHub.
