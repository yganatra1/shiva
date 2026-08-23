# Shiva face service

This is Shiva's private, stateless face-analysis adapter. It detects faces with
InsightFace `buffalo_l`, returns normalized 512-dimension recognition
embeddings, and supplies explainable image-quality signals. Shiva's Node API
owns people, enrollment policy, matching thresholds, and PostgreSQL storage;
this process has no database client and never writes uploaded photos to disk.

The service is an internal model boundary, not a public API. Bind it to
localhost for a direct deployment or expose it only on the private Compose
network. Face embeddings are sensitive biometric data even though they are not
photographs, so the caller must not log or expose them.

## Runtime

From the repository root, create a dedicated environment and install the pinned
runtime range:

```bash
python3 -m venv /workspace/shiva/venvs/face
source /workspace/shiva/venvs/face/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r face/requirements.txt
```

InsightFace also declares the GUI OpenCV package. Restore the headless package
last on the server (the Dockerfile performs this step automatically):

```bash
python -m pip uninstall -y opencv-python
python -m pip install --force-reinstall --no-deps \
  'opencv-python-headless>=4.11,<5'
```

The default installation uses CPU ONNX Runtime even when the host has a CUDA
GPU. The `buffalo_l` download is cached under
`$FACE_MODEL_ROOT/models/buffalo_l/`. For the persistent RunPod workspace, set
`FACE_MODEL_ROOT=/workspace/shiva/models/insightface`.

Start the process and explicitly warm the model before serving real traffic:

```bash
python -m face.server
curl -fsS http://127.0.0.1:8103/health
curl -fsS -X POST http://127.0.0.1:8103/warmup
```

`GET /health` is a cheap liveness check and deliberately does not load or
download model weights. `POST /warmup` lazy-loads them once and reports the
actual recognition execution provider. The shipped configuration uses
`CPUExecutionProvider`, leaving the GPU available to Shiva's language and voice
models.

## Analyze contract

`POST /analyze?mode=enroll|verify|identify` accepts one raw JPEG, PNG, or WebP
body of at most 10 MiB. Multipart form data and URLs are not accepted.

```bash
curl -fsS -X POST \
  'http://127.0.0.1:8103/analyze?mode=enroll' \
  -H 'Content-Type: image/jpeg' \
  --data-binary @portrait.jpg
```

Success has this exact shape (the embedding contains 512 finite numbers):

```json
{
  "model": "buffalo_l",
  "dimensions": 512,
  "provider": "CPUExecutionProvider",
  "image": {"width": 1280, "height": 960},
  "faces": [
    {
      "embedding": [0.01],
      "boundingBox": {"x1": 240.0, "y1": 100.0, "x2": 720.0, "y2": 700.0},
      "detectionScore": 0.99,
      "qualityScore": 0.91,
      "enrollmentEligible": true,
      "rejectionReasons": []
    }
  ]
}
```

`enroll` and `verify` require exactly one detected face. They return HTTP 422
with `NO_FACE_DETECTED` or `MULTIPLE_FACES_DETECTED` otherwise. `identify`
returns zero through `FACE_MAX_IDENTIFY_FACES` faces; a no-face photo is a
successful response with an empty `faces` array.

Low-quality single-face images still return HTTP 200 so the caller can show
specific guidance. `enrollmentEligible=false` is accompanied by one or more of
these stable reason codes:

- `LOW_DETECTION_SCORE`
- `FACE_TOO_SMALL`
- `IMAGE_TOO_BLURRY`
- `IMAGE_TOO_DARK`
- `IMAGE_TOO_BRIGHT`
- `FACE_PARTIALLY_OUT_OF_FRAME`

The quality score combines detection strength, face size, crop sharpness,
exposure, and framing. It ranks enrollment samples; it is not an identity
confidence or a calibrated probability. Identity decisions must use cosine
similarity thresholds calibrated against the actual gallery and camera.

Other stable request errors include `INVALID_ANALYSIS_MODE`,
`UNSUPPORTED_IMAGE_TYPE`, `UNSUPPORTED_IMAGE_FORMAT`,
`ANIMATED_IMAGE_UNSUPPORTED`, `EMPTY_IMAGE`, `IMAGE_TOO_LARGE`,
`IMAGE_PIXEL_LIMIT_EXCEEDED`, `INVALID_IMAGE`, and
`FACE_MODEL_UNAVAILABLE`. Responses never include internal exception details.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACE_HOST` | `127.0.0.1` | Bind address |
| `FACE_PORT` | `8103` | Internal service port |
| `FACE_MODEL` | `buffalo_l` | InsightFace model pack |
| `FACE_MODEL_ROOT` | `~/.insightface` | Persistent model root |
| `FACE_PROVIDER` | `cpu` | Provider policy: `cpu`, `auto`, or `cuda` |
| `FACE_REQUIRE_CUDA` | `false` | Legacy CUDA-required override; leave false for CPU |
| `FACE_CUDA_DEVICE_ID` | `0` | CUDA device index |
| `FACE_DETECTION_SIZE` | `640` | Square SCRFD detection input |
| `FACE_DETECTION_THRESHOLD` | `0.5` | Detector candidate threshold |
| `FACE_MAX_IMAGE_PIXELS` | `25000000` | Decoded pixel cap |
| `FACE_MAX_IDENTIFY_FACES` | `20` | Faces returned for identification |
| `FACE_MIN_DETECTION_SCORE` | `0.65` | Enrollment quality floor |
| `FACE_MIN_FACE_SIZE` | `96` | Minimum face side in source pixels |
| `FACE_MIN_SHARPNESS` | `40` | Laplacian-variance floor |
| `FACE_MIN_BRIGHTNESS` | `35` | Dark-image floor |
| `FACE_MAX_BRIGHTNESS` | `220` | Bright-image ceiling |

Run exactly one Uvicorn worker per model instance. Native inference is
serialized so cancellation cannot allow a following request to overlap a still
running ONNX call.

`FACE_PROVIDER=cpu` selects only `CPUExecutionProvider`, even when CUDA is
available. `auto` prefers CUDA and falls back to CPU. `cuda` requires CUDA and
fails warmup if it cannot be initialized. The CPU Docker image intentionally
contains `onnxruntime`, not `onnxruntime-gpu`, and receives no Compose GPU
reservation. Enabling CUDA therefore also requires installing the GPU runtime
and granting the container a GPU; changing the environment variable alone is
not enough.

## Tests

The focused tests inject a fake engine and do not install InsightFace, OpenCV,
ONNX Runtime, model weights, or GPU support:

```bash
python3 -m venv /tmp/shiva-face-tests
source /tmp/shiva-face-tests/bin/activate
python -m pip install \
  'fastapi>=0.116,<1' \
  'httpx>=0.28,<1' \
  'python-dotenv>=1.1,<2'
python -m unittest face.test_engine face.test_server
deactivate
```

These tests verify response shape, size/type limits, one-face versus multi-face
mode behavior, stable error codes, quality reasons, embedding normalization,
concurrent lazy loading, explicit CPU selection, automatic fallback, and
sanitized failures. A separate live
smoke test on the Shiva machine is still required to prove the model download,
CUDA provider, and representative known/unknown face behavior.

## Model license and security boundary

InsightFace library code is MIT, while its supplied pretrained recognition
packs including `buffalo_l` are restricted to non-commercial research unless
separately licensed. Replace or license the weights before commercial use.

This version does not implement liveness or presentation-attack detection. A
face match must not unlock Shiva, approve sensitive actions, or serve as sole
authentication; a photo or screen replay may be accepted by the recognizer.
