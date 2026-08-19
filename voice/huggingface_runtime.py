import logging
import os


LOGGER = logging.getLogger("uvicorn.error")
LEGACY_TRANSFER_VARIABLE = "HF_HUB_ENABLE_HF_TRANSFER"


def prepare_huggingface_environment() -> None:
    """Remove the deprecated transfer switch before Hugging Face is imported."""
    legacy_value = os.environ.pop(LEGACY_TRANSFER_VARIABLE, None)
    if legacy_value is not None and legacy_value.strip().lower() in {
        "1",
        "on",
        "true",
        "yes",
    }:
        LOGGER.warning(
            "Ignoring deprecated %s; use HF_XET_HIGH_PERFORMANCE=1 "
            "for supported Hugging Face Hub versions.",
            LEGACY_TRANSFER_VARIABLE,
        )
