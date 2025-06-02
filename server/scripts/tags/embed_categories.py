import json
from pathlib import Path

import yaml
from openai import Client
from pgvector.sqlalchemy import Vector
from pydantic import BaseModel
from rich import get_console
from sqlalchemy import Integer, String
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
)

from utils import get_session

console = get_console()
with Path.open("data/categories.yml") as f:
    categories_data = yaml.safe_load(f)
console = get_console()
client = Client()
with Path.open("data/tag_group_gt_100.json") as f:
    data = json.load(f)


general_tags = data["tag_string_general"]


class Base(DeclarativeBase): ...


class Category(BaseModel):
    name: str
    children: list["Category"] | None = None


# 解析 YAML 中的类别结构，应用到我们的 Category 类模型
def load_categories(categories_data: dict) -> list[Category]:
    result = []
    for category in categories_data["categories"]:
        result.append(Category.model_validate(category))
    return result


categories = load_categories(categories_data)


def get_leaf_categories(categories: list[Category]) -> list[Category]:
    """Recursively get all leaf categories from a nested category structure"""
    leaf_categories = []
    for category in categories:
        if category.children is None:
            leaf_categories.append(category)
        else:
            leaf_categories.extend(get_leaf_categories(category.children))
    return leaf_categories


def get_breadcrumb_paths(categories: list[Category], current_path: list[str] | None = None) -> list[list[str]]:
    """
    Recursively get all category paths in a breadcrumb-like format
    Returns a list of paths, where each path is a list of category names from root to leaf
    """
    if current_path is None:
        current_path = []

    all_paths = []
    for category in categories:
        # Create a new path including the current category
        new_path = [*current_path, category.name]

        if category.children is None:
            # This is a leaf category, add the complete path to results
            all_paths.append(new_path)
        else:
            # This is not a leaf, continue traversing with the updated path
            child_paths = get_breadcrumb_paths(category.children, new_path)
            all_paths.extend(child_paths)

    return all_paths


# Get all leaf categories
leaf_categories = get_leaf_categories(categories)
leaf_categories_name_set = {category.name for category in leaf_categories}
leaf_categories_names = list(leaf_categories_name_set)

# Get all breadcrumb paths
breadcrumb_paths = [" / ".join(p) for p in get_breadcrumb_paths(categories)]


# Model to store category path embeddings
class CategoryPathEmbedding(Base):
    __tablename__ = "category_path_embeddings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    path: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    embedding: Mapped[Vector] = mapped_column(Vector(1536), nullable=False)  # Using 1536 dimensions for OpenAI embeddings


# Generate embeddings for each breadcrumb path
def get_embedding(text: str) -> list[float]:
    """Get an embedding from OpenAI API"""
    response = client.embeddings.create(
        input=text,
        model="text-embedding-3-large",
        dimensions=1536,
    )
    return response.data[0].embedding


# Function to store breadcrumb paths and their embeddings
def store_category_path_embeddings(session: Session, paths: list[str]) -> None:
    """Store category paths and their embeddings in the database"""
    console.print(f"Generating embeddings for {len(paths)} category paths...")

    for i, path in enumerate(paths):
        if session.query(CategoryPathEmbedding).filter(CategoryPathEmbedding.path == path).first():
            console.print(f"Path already exists: {path}")
            continue

        # Generate embedding
        try:
            embedding = get_embedding(path)

            # Create and store the embedding
            path_embedding = CategoryPathEmbedding(
                path=path,
                embedding=embedding,
            )
            session.add(path_embedding)

            # Log progress
            if (i + 1) % 10 == 0 or i == len(paths) - 1:
                console.print(f"Processed {i + 1}/{len(paths)} paths")
                session.commit()

        except Exception as e:
            console.print(f"Error generating embedding for path '{path}': {e}")
            session.rollback()

    # Final commit
    session.commit()
    console.print("Finished storing category path embeddings")


# %%
# If this script is run directly, store all breadcrumb path embeddings
if __name__ == "__main__":
    # Get database session
    session = get_session()
    engine = session.get_bind()
    # Create the table if it doesn't exist
    Base.metadata.create_all(engine)

    # Store all breadcrumb path embeddings
    store_category_path_embeddings(session, breadcrumb_paths)
    # Close the session
    session.close()
