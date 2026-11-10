import base64
from io import BytesIO
from os import PathLike
from pathlib import Path

import PIL.Image
import PIL.ImageOps
from openai import OpenAI
from rich import get_console

console = get_console()

#: The upload is a thumbnail, not the original. The request asks for
#: ``detail: "low"``, which the API serves from a 512x512 image anyway, so
#: anything larger is bytes encoded, base64'd and sent only to be thrown away.
UPLOAD_MAX_SIDE = 512


class OpenAIImageAnnotator:
    MODEL = "gpt-4.1-nano"

    def __init__(self, api_key: str) -> None:
        self.client = OpenAI(api_key=api_key)

    def get_img_base64(self, image: PIL.Image.Image) -> str:
        """JPEG-encode ``image`` (RGB) — the data URL below says ``image/jpeg`` to match."""
        buffered = BytesIO()
        image.save(buffered, format="JPEG", quality=90)
        return base64.b64encode(buffered.getvalue()).decode("utf-8")

    @staticmethod
    def load_upload_image(image_path: PathLike | str) -> PIL.Image.Image:
        """Open with PIL, apply the EXIF orientation, shrink to the upload size, RGB.

        Replaces ``diffusers``' ``load_image`` (EXIF transpose + RGB convert),
        which pulled seven seconds of diffusers imports in for those two calls.
        """
        with PIL.Image.open(Path(image_path)) as opened:
            image = PIL.ImageOps.exif_transpose(opened)
            image.thumbnail((UPLOAD_MAX_SIDE, UPLOAD_MAX_SIDE))
            return image.convert("RGB")

    def annotate_image(self, image_path: PathLike | str) -> str:
        base64_image = self.get_img_base64(self.load_upload_image(image_path))
        response = self.client.chat.completions.create(
            model=self.MODEL,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Create a caption for the image. "
                                "You must use simple natural language. Your caption need to be as specific as possible"
                                "and should be distinguishable from other images. You should include all the content "
                                "and elements in the image."
                                "The caption should shorter than 60 words."
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}",
                                "detail": "low",
                            },
                        },
                    ],
                },
            ],
            max_tokens=200,
        )
        if response.choices[0].message.content is None:
            return ""
        return response.choices[0].message.content


if __name__ == "__main__":
    api_key = ""
    image_path = R"demo/1.jpg"
    annotator = OpenAIImageAnnotator(api_key)
    annotations = annotator.annotate_image(image_path)
    console.log(annotations)
