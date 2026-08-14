import math
from io import BufferedReader
from os import PathLike

import PIL.Image

from .colorthief import ColorThief

ImageSource = PathLike | BufferedReader | PIL.Image.Image


def _prepare_image(image: ImageSource) -> tuple[PIL.Image.Image, int]:
    if not isinstance(image, PIL.Image.Image):
        image = PIL.Image.open(image)
    width, height = image.size
    target_points = 10000
    quality = int(math.sqrt((width * height) / target_points))
    return image, quality


def get_palette(image: ImageSource, *, colors: int = 5) -> tuple[tuple[int, int, int], ...]:
    image, quality = _prepare_image(image)
    color_thief = ColorThief(image)
    return tuple(color_thief.get_palette(color_count=colors, quality=quality))


def get_dominant_color(image: ImageSource) -> tuple[int, int, int]:
    image, quality = _prepare_image(image)
    color_thief = ColorThief(image)
    return color_thief.get_color(quality=quality)


def rgb2int(rgb: tuple[int, int, int]) -> int:
    return (rgb[0] << 16) + (rgb[1] << 8) + rgb[2]
