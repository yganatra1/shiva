import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from .provider import TTSProvider, TTSProviderError
from .qwen_provider import QwenTTSProvider

ROOT_ENVIRONMENT = Path(__file__).resolve().parents[2] / ".env"
MAX_TTS_CHARACTERS = 4_000

load_dotenv(ROOT_ENVIRONMENT)


class SynthesisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=MAX_TTS_CHARACTERS)


def create_app(provider: TTSProvider | None = None) -> FastAPI:
    model_name = os.getenv(
        "TTS_MODEL",
        "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    )
    speaker = os.getenv("TTS_SPEAKER", "Aiden")
    selected_provider = provider or QwenTTSProvider(
        model_name=model_name,
        speaker=speaker,
        language=os.getenv("TTS_LANGUAGE", "English"),
        device=os.getenv("TTS_DEVICE", "cuda:0"),
    )
    application = FastAPI(title="Shiva TTS", version="0.3.0")

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "service": "tts",
            "model": model_name,
            "speaker": speaker,
        }

    @application.post("/synthesize", response_class=Response)
    async def synthesize(request: SynthesisRequest) -> Response:
        try:
            speech = await selected_provider.synthesize(request.text)
        except TTSProviderError as error:
            raise HTTPException(
                status_code=503,
                detail="The TTS model is unavailable.",
            ) from error

        return Response(
            content=speech.wav,
            media_type="audio/wav",
            headers={"Cache-Control": "no-store"},
        )

    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("TTS_HOST", "127.0.0.1"),
        port=int(os.getenv("TTS_PORT", "8102")),
    )
