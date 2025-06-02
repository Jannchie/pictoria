#!/usr/bin/env python
"""
CSV tag classification file conversion to YAML hierarchical structure script.

This script converts CSV format tag classification data into a YAML file with hierarchical structure,
making it easier to use and maintain in applications.
"""

import csv
import logging
import re
import sys
from pathlib import Path
from typing import Any

import yaml

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

# Configure file paths
DEFAULT_CSV_PATH = "data/tag_classification.csv"
DEFAULT_YAML_PATH = "data/tag_classification.yml"


def read_csv_file(file_path: str) -> list[list[str]]:
    """
    Read CSV file and convert it to a list of paths.

    Args:
        file_path: Path to the CSV file

    Returns:
        List containing classification paths, each element is a path list

    Raises:
        FileNotFoundError: If the CSV file does not exist
        Exception: If an error occurs during the reading process
    """
    csv_path = Path(file_path)
    if not csv_path.exists():
        msg = f"CSV file not found: {file_path}"
        raise FileNotFoundError(msg)

    with csv_path.open(encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile, ["tag", "category_path"])
        data = list(reader)
        paths = []

        for row in data:
            # Parse the category path and add the tag as the last element
            path = row["category_path"].split(" / ")
            path.append(row["tag"])
            paths.append(path)

    logger.info(f"Successfully read {len(paths)} tag classifications from {file_path}")  # noqa: G004
    return paths


def post_process_paths(paths: list[list[str]]) -> list[list[str]]:
    """
    Post-process the paths list for custom tag classification modifications.

    This function allows for manual adjustments to the tag paths after
    reading from CSV but before creating the nested structure. Custom rules
    can be added here to modify specific tags' categorization.

    Args:
        paths: List containing classification paths, each element is a path list

    Returns:
        List of paths after custom modifications
    """
    # 将所有带有 _(planet) 后缀的标签移动到 Celestial Bodies 分类下
    celestial_bodies_path = ["Content", "Abstract Concepts", "Natural Phenomena", "Celestial Bodies"]
    card_games_path = ["Content", "Objects", "Games & Entertainment", "Card Games & Cards"]
    special_theme_path = ["Content", "Concepts & Themes", "Themes & Genres", "Specific Themes"]
    emotion_and_feelings_path = ["Content", "Concepts & Themes", "Abstract Concepts", "Emotions & Feelings"]
    emotion_and_states_path = ["Content", "Concepts", "Concepts & Themes", "Emotions & States"]
    emote_path = ["Visuals", "Appearance", "Head", "Face", "Facial Expressions", "Emotes"]
    for i, path in enumerate(paths):
        # 检查标签是否具有 xxx_(planet) 格式
        tag = path[-1]
        if tag.endswith("_(planet)"):
            # 创建新路径，将标签放在 Celestial Bodies 分类下
            new_path = celestial_bodies_path.copy()
            new_path.append(tag)
            paths[i] = new_path
            logger.info("Moved planet tag '%s' to Celestial Bodies category", tag)
        elif tag.endswith("_(tarot)"):
            # 创建新路径，将标签放在 Card Games & Cards 分类下
            new_path = card_games_path.copy()
            new_path.append(tag)
            paths[i] = new_path
            logger.info("Moved tarot tag '%s' to Card Games & Cards category", tag)
        elif tag.endswith("_(meme)"):
            # 创建新路径，将标签放在 Specific Themes 分类下
            new_path = special_theme_path.copy()
            new_path.append(tag)
            paths[i] = new_path
            logger.info("Moved meme tag '%s' to Specific Themes category", tag)
        # path 是 emotion_and_feelings_path 的子路径，将其移动到 emotion_and_states_path 分类下
        elif path[:-2] == emotion_and_feelings_path:
            # 创建新路径，将标签放在 Emotions & States 分类下
            new_path = emotion_and_states_path.copy()
            new_path.append(tag)
            paths[i] = new_path
            logger.info("Moved feelings tag '%s' to Emotions & States category", tag)

        # 使用正则，如果 tag 是数量，然后是可选的加号，然后是 girl, boy, girls, boys，则分类到 Demographics 里
        regex = r"^\d+\+?\s*(girl|boy)s?$"
        if re.match(regex, tag):
            # 创建新路径，将标签放在 Demographics 分类下
            new_path = ["Content", "Living Things", "People", "Demographics"]
            new_path.append(tag)
            paths[i] = new_path
            logger.info("Moved demographics tag '%s' to Demographics category", tag)

        if tag in [
            "3:",
            "3;",
            "3_3",
            ":|",
            ">_<",
            ">:(",
            ":3",
            ":d",
            ":o",
            ";3",
            ">3<",
            ">:)",
            ">o<",
            "\\(^o^)/",
            "\\o/",
            "^_^",
            "^o^",
            "x_x",
            "t_t",
            "o3o",
            "o_o",
            "+_+",
            "+_-",
            "._.",
            "0_0",
            ";|",
            "=_=",
            "@_@",
            "\\m/",
            ":>=",
            ":c",
            ";)",
        ]:
            # 创建新路径，将标签放在 Emotes 分类下
            new_path = emote_path.copy()
            new_path.append(tag)
            paths[i] = new_path
            logger.info("Moved emote tag '%s' to Emotes category", tag)
    logger.info("Applied custom post-processing to tag paths")
    return paths


def paths_to_nested_structure(paths: list[list[str]]) -> dict[str, Any]:
    """
    Convert path list to a nested hierarchical structure.

    Args:
        paths: List containing classification paths, each element is a path list

    Returns:
        Dictionary containing the nested category structure
    """
    # Create root node
    root = {"categories": []}

    # Track created categories
    categories = {}

    for path in paths:
        current_categories = root["categories"]

        # Process each part of the path (except the last one, which is the tag)
        for i, part in enumerate(path[:-1]):
            # Build the current path
            current_path = "/".join(path[: i + 1])

            # Check if this category already exists
            if current_path not in categories:
                # Create a new category node
                new_category = {"name": part}
                current_categories.append(new_category)
                categories[current_path] = new_category

                # If not a leaf node, add a children list
                if i < len(path) - 2:  # Not the second last (i.e., not the parent of a leaf node)
                    new_category["children"] = []

            # Get current category node
            current_category = categories[current_path]

            # Update current category list to the current node's children
            if i < len(path) - 2:  # If not the second last node
                current_categories = current_category["children"]
            else:  # It's the second last node (i.e., the parent of the tag)
                # Ensure it has a children field
                if "children" not in current_category:
                    current_category["children"] = []
                leaf_exists = any(child["name"] == path[-1] for child in current_category["children"])
                if not leaf_exists:
                    current_category["children"].append({"name": path[-1]})

    logger.info("Successfully created nested structure with %d categories", len(categories))
    return root


def merge_same_name_categories(structure: dict[str, Any]) -> dict[str, Any]:
    """
    Handle special cases: merge categories with the same name but different paths.

    Args:
        structure: Dictionary containing the category structure

    Returns:
        Dictionary with the structure after merging same-name categories
    """

    # Recursive function to process each level of categories
    def merge_categories(categories: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not categories:
            return categories

        # Store merged categories
        merged = []
        name_to_category = {}

        # First pass: collect categories with the same name
        for category in categories:
            name = category["name"]
            if name in name_to_category:
                # Merge children
                if category.get("children"):
                    if "children" not in name_to_category[name]:
                        name_to_category[name]["children"] = []
                    name_to_category[name]["children"].extend(category["children"])
            else:
                name_to_category[name] = category
                merged.append(category)

        # Recursively process children
        for category in merged:
            if category.get("children"):
                category["children"] = merge_categories(category["children"])

        return merged

    # Process top-level categories
    structure["categories"] = merge_categories(structure["categories"])
    logger.info("Successfully merged same-name categories")
    return structure


def post_process_structure(structure: dict[str, Any]) -> dict[str, Any]:
    """
    Post-process the structure for custom tag classification modifications.

    This function allows for manual adjustments to the tag hierarchy after
    the initial structure is created from the CSV data. Custom rules can be
    added here to modify specific tags' categorization.

    Args:
        structure: Dictionary containing the category structure

    Returns:
        Dictionary with the structure after custom modifications
    """
    # TODO: Add custom tag classification modifications here
    # Example:
    # - Move tags between categories
    # - Create new categories
    # - Rename or merge specific categories

    logger.info("Applied custom post-processing to tag classification")
    return structure


def write_yaml_file(data: dict[str, Any], file_path: str) -> None:
    """
    Write data to a YAML file.

    Args:
        data: Data to be written
        file_path: Path to the YAML file

    Raises:
        IOError: If an error occurs during the writing process
    """
    yaml_path = Path(file_path)
    # Ensure the target directory exists
    yaml_path.parent.mkdir(parents=True, exist_ok=True)

    with Path.open(file_path, "w", encoding="utf-8") as yamlfile:
        yaml.dump(
            data,
            yamlfile,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
    logger.info("Successfully wrote classification data to %s", file_path)


def convert_csv_to_yaml(csv_path: str = DEFAULT_CSV_PATH, yaml_path: str = DEFAULT_YAML_PATH) -> None:
    """
    Convert CSV tag classification file to YAML hierarchical structure.

    Args:
        csv_path: CSV file path
        yaml_path: Output YAML file path
    """
    # 1. Read CSV file and parse to path list
    paths = read_csv_file(csv_path)

    # 2. Post-process paths for any custom modifications
    processed_paths = post_process_paths(paths)

    paths.sort()

    # 3. Convert path list to nested structure
    nested_structure = paths_to_nested_structure(processed_paths)

    # 4. Merge same-name categories
    merged_structure = merge_same_name_categories(nested_structure)

    # 5. Post-process structure for any custom modifications
    final_structure = post_process_structure(merged_structure)

    # 6. Write nested structure to YAML file
    write_yaml_file(final_structure, yaml_path)

    logger.info("Conversion process completed successfully")


def main():
    """
    Main function, handles command line arguments and executes conversion.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Convert CSV tag classification file to YAML hierarchical structure")
    parser.add_argument(
        "--csv",
        "-c",
        default=DEFAULT_CSV_PATH,
        help=f"CSV file path (default: {DEFAULT_CSV_PATH})",
    )
    parser.add_argument(
        "--yaml",
        "-y",
        default=DEFAULT_YAML_PATH,
        help=f"Output YAML file path (default: {DEFAULT_YAML_PATH})",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show detailed logs",
    )

    args = parser.parse_args()

    # If verbose logging is requested, set log level to DEBUG
    if args.verbose:
        logger.setLevel(logging.DEBUG)

    convert_csv_to_yaml(args.csv, args.yaml)


if __name__ == "__main__":
    main()
