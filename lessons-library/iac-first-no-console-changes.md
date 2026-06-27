# IaC-first, no console changes

**Trigger:** You're about to create or change a cloud resource through a console click or a one-off imperative script.

**Failure mode:** Console/bash-script changes have no state, no diff, no review, and drift silently from any written intent. The "source of truth" becomes tribal knowledge, and rebuilding the environment is impossible.

**Correct behavior:**
- Provision every cloud resource via version-controlled IaC (e.g. Terraform/CDK/Pulumi) with managed state.
- Require plan/diff review before apply.
- Run drift detection and reconcile drift back into code.
- Treat an imperative console/script change as not a source of truth — never the system of record.

**Check:** Can you rebuild this resource from code alone, and does a plan show zero drift?

**Seen in:** recurring across multiple production projects.
