import os
import unittest
from unittest.mock import patch

from voice.huggingface_runtime import prepare_huggingface_environment


class HuggingFaceRuntimeTest(unittest.TestCase):
    def test_deprecated_transfer_flag_is_removed(self) -> None:
        environment = {
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "HF_XET_HIGH_PERFORMANCE": "1",
        }

        with patch.dict(os.environ, environment, clear=True):
            with self.assertLogs("uvicorn.error", level="WARNING") as logs:
                prepare_huggingface_environment()

            self.assertNotIn("HF_HUB_ENABLE_HF_TRANSFER", os.environ)
            self.assertEqual(os.environ["HF_XET_HIGH_PERFORMANCE"], "1")
            self.assertIn("Ignoring deprecated", "\n".join(logs.output))

    def test_modern_transfer_setting_is_left_unchanged(self) -> None:
        with patch.dict(
            os.environ,
            {"HF_XET_HIGH_PERFORMANCE": "1"},
            clear=True,
        ):
            prepare_huggingface_environment()

            self.assertEqual(os.environ["HF_XET_HIGH_PERFORMANCE"], "1")


if __name__ == "__main__":
    unittest.main()
