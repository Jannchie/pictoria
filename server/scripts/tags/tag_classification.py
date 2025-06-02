# %%
import csv
import json

# Add the parent directory to the path to import server modules
import sys
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from dotenv import load_dotenv
from openai import Client
from pgvector.sqlalchemy import Vector
from pydantic import BaseModel
from rich import get_console
from rich.progress import Progress, track
from sqlalchemy import Float, Integer, String, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from utils import get_session

sys.path.append(str(Path(__file__).resolve().parent.parent))


# Load environment variables
load_dotenv()

console = get_console()
client = Client()

# Load categories from YAML file
with Path.open("data/categories.yml") as f:
    categories = yaml.safe_load(f)

# Load tag data
with Path.open("data/tag_group_gt_100.json") as f:
    data = json.load(f)

general_tags = data["tag_string_general"][1:]
console.print(f"Loaded {len(general_tags)} general tags")


class Base(DeclarativeBase): ...


class Category(BaseModel):
    name: str
    children: list["Category"] | None = None


# Model to store category path embeddings
class CategoryPathEmbedding(Base):
    __tablename__ = "category_path_embeddings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    path: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    embedding: Mapped[Vector] = mapped_column(Vector(1536), nullable=False)


# Model to store tag embeddings for caching
class TagEmbedding(Base):
    __tablename__ = "tag_embeddings"

    tag: Mapped[str] = mapped_column(String, primary_key=True, nullable=False, index=True)
    embedding: Mapped[Vector] = mapped_column(Vector(1536), nullable=False)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)  # timestamp


# Model to store the tag classification results
class TagCategoryMapping(Base):
    __tablename__ = "tag_category_mappings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tag: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    category_path: Mapped[str] = mapped_column(String, nullable=False)
    similarity: Mapped[float] = mapped_column(Float, nullable=False)


categories = [Category.model_validate(category) for category in categories["categories"]]


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


# Get all breadcrumb paths
breadcrumb_paths = [" / ".join(p) for p in get_breadcrumb_paths(categories)]
console.print(f"Found {len(breadcrumb_paths)} unique category paths")


def get_embedding(text: str, session: Session = None) -> list[float]:
    """Get an embedding from OpenAI API, with caching"""
    # Check if we have a session to use for caching
    if session and (
        cached := session.scalar(
            select(TagEmbedding).where(TagEmbedding.tag == text),
        )
    ):
        console.print(f"[green]Found cached embedding for '{text}'")
        return cached.embedding

    # If not cached or no session provided, generate the embedding
    response = client.embeddings.create(
        input=text,
        model="text-embedding-3-large",
        dimensions=1536,
    )
    embedding = response.data[0].embedding

    # Cache the embedding if we have a session
    if session:
        import time

        tag_embedding = TagEmbedding(tag=text, embedding=embedding, created_at=time.time())
        session.add(tag_embedding)
        session.commit()
        console.print(f"[blue]Cached embedding for '{text}'")

    return embedding


def get_embeddings_batch(texts: list[str], batch_size: int = 100, session: Session = None) -> dict[str, list[float]]:  # noqa: C901, PLR0912
    # sourcery skip: low-code-quality
    """Get embeddings for a batch of texts with caching"""
    result = {}

    # First check for cached embeddings if session is provided
    texts_to_process = texts
    if session:
        # Check which texts already have cached embeddings
        cached_tags = {}
        for chunk in [texts[i : i + 500] for i in range(0, len(texts), 500)]:  # Process in chunks to avoid large IN clause
            cached_results = session.execute(
                select(TagEmbedding).where(TagEmbedding.tag.in_(chunk)),
            ).all()
            for row in cached_results:
                tag_embedding = row[0]
                cached_tags[tag_embedding.tag] = tag_embedding.embedding

        # Add cached embeddings to the result
        if cached_tags:
            console.print(f"[green]Found {len(cached_tags)} cached embeddings")
            result |= cached_tags

            # Filter out texts that are already cached
            texts_to_process = [text for text in texts if text not in cached_tags]

            if not texts_to_process:
                console.print("[green]All embeddings found in cache!")
                return result

    with Progress() as progress:
        task = progress.add_task("[cyan]Generating embeddings...", total=len(texts_to_process))

        for i in range(0, len(texts_to_process), batch_size):
            batch = texts_to_process[i : i + batch_size]
            try:
                response = client.embeddings.create(
                    input=batch,
                    model="text-embedding-3-large",
                    dimensions=1536,
                )

                # Associate each embedding with its text and cache them
                import time

                current_time = time.time()

                for j, embedding_data in enumerate(response.data):
                    text = batch[j]
                    embedding = embedding_data.embedding
                    result[text] = embedding

                    # Cache the embedding if we have a session
                    if session:
                        session.add(
                            TagEmbedding(
                                tag=text,
                                embedding=embedding,
                                created_at=current_time,
                            ),
                        )

                # Commit in batches to save the cache
                if session:
                    session.commit()
                    console.print(f"[blue]Cached {len(batch)} new embeddings")

                progress.update(task, advance=len(batch))

            except Exception as e:
                console.print(f"[red]Error generating embeddings for batch starting at {i}: {e}")
                # If there's an error with a large batch, try processing texts individually
                if len(batch) > 1:
                    for text in batch:
                        try:
                            result[text] = get_embedding(text, session)
                            progress.update(task, advance=1)
                        except Exception as inner_e:
                            console.print(f"[red]Error generating embedding for text '{text}': {inner_e}")

    return result


def find_most_similar_category(tag_embedding: list[float], category_embeddings: dict[str, list[float]]) -> tuple[str, float]:
    """
    Find the most similar category for a tag embedding
    Returns the category path and the similarity score
    """
    max_similarity = -1
    most_similar_category = None

    tag_embedding_array = np.array(tag_embedding)

    for category_path, category_embedding in category_embeddings.items():
        category_embedding_array = np.array(category_embedding)

        # Calculate cosine similarity
        similarity = np.dot(tag_embedding_array, category_embedding_array) / (np.linalg.norm(tag_embedding_array) * np.linalg.norm(category_embedding_array))

        if similarity > max_similarity:
            max_similarity = similarity
            most_similar_category = category_path

    return most_similar_category, max_similarity


def classify_tags(session: Session) -> dict[str, dict[str, Any]]:
    """
    Classify all general tags using embeddings and save the results
    Returns a dictionary mapping each tag to its classification details
    """
    console.print("[bold green]Loading category embeddings from database...")

    # Get all category embeddings from the database
    category_embeddings = {}
    results = session.execute(select(CategoryPathEmbedding)).all()
    for result in results:
        category_path_embedding = result[0]
        category_embeddings[category_path_embedding.path] = category_path_embedding.embedding

    console.print(f"[green]Loaded {len(category_embeddings)} category embeddings")

    # If we have no category embeddings in the database, we need to create them
    if not category_embeddings:
        category_embeddings = _generate_and_store_category_embeddings(session)

    # Generate embeddings for all general tags
    console.print("[bold green]Generating embeddings for general tags...")
    tag_embeddings = get_embeddings_batch(general_tags, session=session)  # Pass session for caching

    # Classify each tag by finding the most similar category
    console.print("[bold green]Classifying tags...")
    classification_results = {}

    for tag, embedding in track(tag_embeddings.items(), total=len(tag_embeddings), description="Classifying tags"):
        category_path, similarity = find_most_similar_category(embedding, category_embeddings)
        classification_results[tag] = {
            "category_path": category_path,
            "similarity": similarity,
        }

        if existing_mapping := session.execute(
            select(TagCategoryMapping).where(TagCategoryMapping.tag == tag),
        ).scalar_one_or_none():
            # Update existing mapping
            existing_mapping.category_path = category_path
            existing_mapping.similarity = similarity
            session.add(existing_mapping)
        else:
            # Create new mapping
            session.add(
                TagCategoryMapping(
                    tag=tag,
                    category_path=category_path,
                    similarity=similarity,
                ),
            )

    return _commit_session_and_print(
        session,
        "[green]Classification complete and stored in database",
        classification_results,
    )


def _commit_session_and_print(session: Session, message: str, result: dict[str, Any]) -> dict[str, Any]:
    session.commit()
    console.print(message)
    return result


def _generate_and_store_category_embeddings(session: Session) -> dict[str, Any]:
    console.print("[yellow]No category embeddings found in database, generating them...")
    Base.metadata.create_all(session.get_bind())

    # Generate embeddings for all breadcrumb paths
    result = get_embeddings_batch(breadcrumb_paths, session=session)  # Pass session for caching

    # Store the embeddings in the database
    for path, embedding in result.items():
        session.add(CategoryPathEmbedding(path=path, embedding=embedding))

    return _commit_session_and_print(
        session,
        "[green]Generated and stored category embeddings",
        result,
    )


def save_to_csv(classification_results: dict[str, dict[str, Any]], file_path: str = "data/tag_classification.csv"):
    """Save the classification results to a CSV file"""
    with Path.open(file_path, "w", newline="", encoding="utf-8") as csvfile:
        fieldnames = ["tag", "category_path"]
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)

        writer.writeheader()
        for tag, result in classification_results.items():
            writer.writerow(
                {
                    "tag": tag,
                    "category_path": result["category_path"],
                },
            )

    console.print(f"[green]Saved classification results to {file_path}")


# %%
if __name__ == "__main__":
    # Get database session
    session = get_session()
    engine = session.get_bind()

    # Create the tables if they don't exist
    Base.metadata.create_all(engine)

    # Classify tags and save results
    classification_results = classify_tags(session)

    # Save results to CSV
    save_to_csv(classification_results)

    # Close the session
    session.close()

    console.print("[bold green]Tag classification complete!")
