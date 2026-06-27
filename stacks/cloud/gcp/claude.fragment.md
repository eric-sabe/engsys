## Cloud stack

- **Active cloud: GCP.** Architecture and IaC target Google Cloud; agents load the
  `cloud-architecture-gcp` and `gcp-deployment-preflight` skill packs.
- **Tool preference order** (when investigating or validating cloud state):
  1. **gcloud / gsutil, read-only** — `gcloud config get-value project`,
     `gcloud auth list`, `gcloud run services list`, `gcloud sql instances describe`,
     `gcloud logging read`, `gcloud compute regions describe`,
     `gcloud services list --enabled`, `gsutil ls` and similar inspection commands.
     Never mutate state to answer a question.
  2. **Docs source** — official Google Cloud documentation (cloud.google.com/docs) for
     quotas, pricing, and API behavior. Verify against docs rather than from memory.
- Mutating actions (deploy/apply/delete) go through the IaC tool and the
  `gcp-deployment-preflight` gate, never ad-hoc CLI writes.

<!-- naturalize: confirm the GCP project ID(s), region(s), and the path to the
architecture/cost docs Melvin and Aaron should read for concrete topology. -->
