<!-- pack: db/mongo -->
## Database — MongoDB

This project uses MongoDB as a document / data-lake / vector store.
- **Isabelle** and **Bert** load the **`mongo-conventions`** skill when reading or writing collections, creating indexes, or building ingest/transform pipelines.
- **Melvin** and **Patricia** consult **`mongo-conventions`** when designing collection schemas, provenance fields, or MongoDB Atlas topology (M10+ private endpoints, SRV connection strings, disk sizing for restores).
- Always use async drivers (`pymongo.AsyncMongoClient` in Python 3.12+ or the official Node `mongodb` driver in TypeScript) — never EOL `motor` or blocking sync calls on request paths.

<!-- naturalize: record the MongoDB driver, database name, and system-of-record collection(s) in Project facts. -->
