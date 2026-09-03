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
    # colorthief 的 quality 是**步长**（`range(0, pixel_count, quality)`），所以采到的
    # 点数是 pixel_count / quality。原来这里开了个平方根，实际采样数变成
    # 100·sqrt(pixel_count) —— 一张 2328×3720 采了 29.3 万点而不是这里写着的一万，
    # 而 MMCQ 是纯 Python 的，多出来的 30 倍全落在中位切分上。
    #
    # max(1, ...)：步长 0 会让 range 抛 ValueError。小于 target_points 的图整张全采。
    quality = max(1, (width * height) // target_points)
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
