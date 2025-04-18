import os


def is_image(file_path: os.PathLike) -> bool:
    return str(file_path).lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".tiff", ".tif", ".svg"))
