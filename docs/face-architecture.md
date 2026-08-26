# Shiva face-recognition architecture

This version makes face recognition a local identity feature rather than a model demo. A user can create a durable person profile, select 10–15 or more photos, see each sample accepted or rejected independently, reopen the profile later, and use the resulting identity in chat and device-camera results.

## Boundaries

```text
Browser / phone browser
        |
        | /people, /api/people, /face/*
        v
Fastify gateway :3000
  - owns people and gallery policy
  - owner-scopes every query
  - hashes uploads for exact deduplication
  - performs cosine matching and ambiguity checks
        |
        | raw image, private network only
        v
Python face adapter :8103
  - stateless InsightFace inference
  - no PostgreSQL credentials
  - never writes uploaded images
        |
        v
PostgreSQL / pgvector
  people -> aliases -> person_face_embeddings vector(512)
```

`buffalo_l` combines SCRFD-10GF face detection with a ResNet50 recognition model and produces 512-dimensional embeddings. The Python adapter selects only `CPUExecutionProvider` by default, even on a CUDA-capable host, leaving the GPU available to Shiva's language and voice models. `FACE_PROVIDER=auto` and `FACE_PROVIDER=cuda` remain explicit opt-in policies for a separately GPU-enabled runtime. The model loads lazily, caches weights under `FACE_MODEL_ROOT`, and serializes native inference so cancellation cannot overlap a following ONNX call.

## Enrollment

The browser keeps originals local, creates orientation-corrected JPEG copies with a longest side of at most 1600 px, and uploads two images concurrently. Every photo is a separate request, so a failed sample does not roll back accepted samples. The gateway accepts raw JPEG/PNG/WebP bodies up to 10 MiB.

For enrollment Shiva requires exactly one detected face and rejects samples with explainable quality codes for weak detection, small face size, blur, poor exposure, or frame clipping. It L2-normalizes and validates the 512 values again at the gateway, rejects exact duplicate bytes, compares a new template with the person's existing gallery, and rejects a conflicting match in another known person's gallery before storing it. Enrollment is serialized across the owner's gallery in the single Shiva API process so two concurrent first photos cannot independently seed conflicting identities. A gallery is marked `faceReady` after five accepted templates; 10–15 varied photos remain the recommended practical target.

Source photographs are not stored. PostgreSQL can retain a sanitized optional source filename supplied by a trusted API client alongside the normalized template, model name, bounding box, quality/detection scores, timestamps, and a SHA-256 value used only to prevent exact duplicate enrollment. Public APIs return safe sample metadata but never the source filename, vector, or hash; the browser enrollment page does not send filenames.

## Identification and verification

Identification detects up to 20 faces, queries only the configured owner's templates produced by the same model, and compares cosine similarity. Low-quality detections and candidates below `FACE_MATCH_THRESHOLD` remain unknown. A top match too close to a different person's top match by `FACE_AMBIGUITY_MARGIN` also remains unknown. Verification rejects low-quality input instead of turning it into an identity decision. Shiva does not ask the vision model to guess identity from appearance.

Verification compares one detected face only with the requested person's gallery and returns the measured similarity, configured threshold, and boolean result. Neither operation is liveness detection. A printed photo or screen replay may match, so recognition cannot unlock Shiva, approve an action, bypass execution policy, or serve as sole authentication.

Threshold defaults are starting points. Before regular use, build a representative evaluation set across lighting, pose, camera distance, known people, and unknown people. Raise the match threshold if false accepts appear; revisit photo quality and enrollment consistency if false rejects dominate. Do not silently weaken the ambiguity margin to force a name.

## Grounding person details

People are durable entities with a display name, owner marker, aliases, relationship (to the owner), structured details, and notes. The `people_search` skill exposes those facts to the planner without exposing biometrics; `person_create` and `person_update` let Core add and edit them, guarded against accidentally creating a duplicate record for someone who already exists under the same name or alias. When `/chat` receives attached images, Shiva runs local identification first and injects a bounded profile for each confident result as explicitly untrusted personal data. Device camera capture returns the same resolved details beside the non-identifying visual description. If the face service is unavailable, ordinary chat and visual description continue without identity context.

`person_relationships` is a separate directed person-to-person graph (e.g. Yash --father--> Rajesh, Charmi --brother--> Amit), independent of the single owner-relative `relationship` field above. `relationship` is free text with no enum, so new kinds (father, wife, manager, business partner, ...) never need a schema change. `person_relationship_add` records one edge; `person_relationship_search` returns a person's outgoing edges, so the planner can chain lookups to resolve an indirect reference like "call my wife's brother" — resolve the owner, follow "wife" to Charmi, then search again from Charmi for "brother".

## Services and API

The public gateway provides:

- `GET /people`
- `GET|POST /api/people`
- `GET|PATCH|DELETE /api/people/:personId`
- `POST /api/people/:personId/faces`
- `DELETE /api/people/:personId/faces/:faceId`
- `POST /face/enroll?personId=<uuid>`
- `POST /face/identify`
- `POST /face/verify?personId=<uuid>`
- `GET /face/health`

The private Python service provides `GET /health`, `POST /warmup`, and `POST /analyze?mode=enroll|verify|identify`. Its detailed request limits, error codes, environment variables, direct-install commands, and smoke-test checklist are in [`face/README.md`](../face/README.md).

## Licensing

InsightFace source code is MIT-licensed, but the project's supplied pretrained model packs, including `buffalo_l`, are designated for non-commercial research use unless separately licensed. This personal/prototype build must replace or separately license those weights before commercial use. See the official [model zoo](https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md) and [licensing notice](https://github.com/deepinsight/insightface/blob/master/server/LICENSING.md).
