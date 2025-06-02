import json
from pathlib import Path

import numpy as np
import torch
import yaml
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from transformers import AutoModelForCausalLM, AutoTokenizer

from src.db import async_get_session

# Import relevant project modules
from src.models import Tag, TagGroup


class BetterTagClassifier:
    def __init__(self, categories_path: str = "data/categories.yml") -> None:
        """
        Initialize the better tag classifier.

        Args:
            categories_path: Path to the categories YAML file
        """
        self.categories_path = categories_path
        self.categories = self._load_categories()
        self.category_embeddings = {}
        self.tag_embeddings = {}

        # Initialize LLM for category selection
        self.model_name = "mistralai/Mistral-7B-Instruct-v0.2"  # Can be configured based on available hardware
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        self.model = AutoModelForCausalLM.from_pretrained(
            self.model_name,
            torch_dtype=torch.float16,
            device_map="auto",
        )

    def _load_categories(self) -> dict:
        """Load categories from YAML file."""
        with Path.open(self.categories_path, encoding="utf-8") as f:
            return yaml.safe_load(f)

    def _calculate_similarity(self, tag_embedding: np.ndarray, category_embeddings: dict[str, np.ndarray]) -> list[tuple[str, float]]:
        """
        Calculate cosine similarity between a tag embedding and all category embeddings.

        Args:
            tag_embedding: The embedding vector for a tag
            category_embeddings: Dictionary of category name to embedding vector

        Returns:
            List of (category_name, similarity_score) tuples sorted by similarity
        """
        similarities = []
        for category_name, category_embedding in category_embeddings.items():
            # Normalize vectors
            tag_norm = np.linalg.norm(tag_embedding)
            category_norm = np.linalg.norm(category_embedding)

            # Calculate cosine similarity
            if tag_norm > 0 and category_norm > 0:
                similarity = np.dot(tag_embedding, category_embedding) / (tag_norm * category_norm)
                similarities.append((category_name, similarity))

        # Sort by similarity score in descending order
        return sorted(similarities, key=lambda x: x[1], reverse=True)

    def _select_best_category_with_llm(self, tag_name: str, top_categories: list[tuple[str, float]]) -> str:
        """
        Use LLM to select the best category for a tag from the top candidates.

        Args:
            tag_name: The name of the tag
            top_categories: List of (category_name, similarity_score) tuples

        Returns:
            The selected category name
        """
        # Create prompt for LLM
        category_names = [cat[0] for cat in top_categories]
        prompt = f"""<s>[INST] You are an expert image tagging assistant. 
Your task is to select the most appropriate category for a tag from a list of candidates.

Tag: {tag_name}
Candidate categories: {", ".join(category_names)}

Choose the single most appropriate category from the list for this tag. 
Only respond with the exact category name and nothing else. [/INST]"""  # noqa: S608

        # Generate response
        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.model.device)
        outputs = self.model.generate(
            **inputs,
            max_new_tokens=30,
            temperature=0.1,
            top_p=0.9,
            do_sample=True,
        )
        response = self.tokenizer.decode(outputs[0], skip_special_tokens=True).strip()

        # Extract the category name from the response
        response = response.replace(prompt, "").strip()

        # Validate the response against the candidate categories
        for category in category_names:
            if category.lower() in response.lower():
                return category

        # Fallback to the highest similarity category if LLM response doesn't match any candidate
        return top_categories[0][0]

    async def process_tag(self, session: AsyncSession, tag_name: str) -> str | None:
        """
        Process a single tag to classify it into the best category.

        Args:
            session: Database session
            tag_name: Name of the tag to classify

        Returns:
            The selected category name or None if processing failed
        """
        try:
            # Assume tag embedding is already calculated and accessible
            tag_embedding = self.tag_embeddings.get(tag_name)
            if tag_embedding is None:
                print(f"No embedding found for tag: {tag_name}")
                return None

            # Calculate similarity with all categories
            similarities = self._calculate_similarity(tag_embedding, self.category_embeddings)

            # Get top 20 categories
            top_categories = similarities[:20]

            # Use LLM to select the best category
            selected_category = self._select_best_category_with_llm(tag_name, top_categories)

            # Get tag group ID for the selected category
            tag_group = await session.scalar(
                select(TagGroup).where(TagGroup.name == selected_category),
            )

            if not tag_group:
                print(f"Tag group not found for category: {selected_category}")
                return None

            # Update tag with the selected category
            await session.execute(
                update(Tag).where(Tag.name == tag_name).values(group_id=tag_group.id),
            )

            print(f"Tag '{tag_name}' classified as '{selected_category}'")
            return selected_category

        except Exception as e:
            print(f"Error processing tag {tag_name}: {e}")
            return None

    async def load_embeddings(self, categories_embeddings_path: str, tags_embeddings_path: str):
        """
        Load pre-calculated embeddings for categories and tags.

        Args:
            categories_embeddings_path: Path to the categories embeddings file
            tags_embeddings_path: Path to the tags embeddings file
        """
        # Load category embeddings
        with open(categories_embeddings_path) as f:
            self.category_embeddings = json.load(f)

        # Load tag embeddings
        with open(tags_embeddings_path) as f:
            self.tag_embeddings = json.load(f)

        print(f"Loaded {len(self.category_embeddings)} category embeddings and {len(self.tag_embeddings)} tag embeddings")

    async def classify_all_tags(self):
        """Classify all tags in the database."""
        async with async_get_session() as session:
            # Get all tags
            result = await session.execute(select(Tag))
            tags = result.scalars().all()

            print(f"Processing {len(tags)} tags...")

            for tag in tags:
                await self.process_tag(session, tag.name)

            await session.commit()
            print("All tags classified successfully")


async def main():
    """Main function to run the better tag classification."""
    # Paths to embedding files - replace with actual paths
    categories_embeddings_path = "data/category_embeddings.json"
    tags_embeddings_path = "data/tag_embeddings.json"

    classifier = BetterTagClassifier()
    await classifier.load_embeddings(categories_embeddings_path, tags_embeddings_path)
    await classifier.classify_all_tags()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
