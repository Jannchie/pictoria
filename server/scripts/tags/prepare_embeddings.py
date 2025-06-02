import json
import os
import sys

import torch
import yaml
from sqlalchemy import select
from tqdm import tqdm
from transformers import AutoModel, AutoTokenizer

# Add the parent directory to sys.path to import from src
sys.path.append(os.path.join(os.path.dirname(__file__), "../.."))

from src.db import get_session
from src.models import Tag, TagGroup


def load_categories(categories_path="data/categories.yml"):
    """Load categories from YAML file."""
    with open(categories_path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def get_text_embedding(text, model, tokenizer, device="cuda"):
    """Calculate embedding for a piece of text using CLIP."""
    inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True).to(device)

    with torch.no_grad():
        text_features = model.get_text_features(**inputs)

    # Return as numpy array
    return text_features.cpu().numpy()[0]


def create_category_embeddings(categories, output_path="data/category_embeddings.json"):
    """Create embeddings for all categories and save to JSON file."""
    # Load model and tokenizer
    model_name = "openai/clip-vit-large-patch14"
    model = AutoModel.from_pretrained(model_name).to("cuda")
    tokenizer = AutoTokenizer.from_pretrained(model_name)

    category_embeddings = {}

    print(f"Creating embeddings for {len(categories)} categories...")
    for category_name in tqdm(categories):
        embedding = get_text_embedding(category_name, model, tokenizer)
        category_embeddings[category_name] = embedding.tolist()

    # Save to JSON file
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(category_embeddings, f)

    print(f"Category embeddings saved to {output_path}")
    return category_embeddings


def create_tag_embeddings(output_path="data/tag_embeddings.json"):
    """Create embeddings for all tags in the database and save to JSON file."""
    # Load model and tokenizer
    model_name = "openai/clip-vit-large-patch14"
    model = AutoModel.from_pretrained(model_name).to("cuda")
    tokenizer = AutoTokenizer.from_pretrained(model_name)

    tag_embeddings = {}

    # Get all tags from database
    with get_session() as session:
        result = session.execute(select(Tag))
        tags = result.scalars().all()

        print(f"Creating embeddings for {len(tags)} tags...")
        for tag in tqdm(tags):
            embedding = get_text_embedding(tag.name, model, tokenizer)
            tag_embeddings[tag.name] = embedding.tolist()

    # Save to JSON file
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(tag_embeddings, f)

    print(f"Tag embeddings saved to {output_path}")
    return tag_embeddings


def ensure_tag_groups_exist(categories):
    """Ensure all categories exist as tag groups in the database."""
    with get_session() as session:
        # Get existing tag groups
        result = session.execute(select(TagGroup))
        existing_groups = {group.name: group for group in result.scalars().all()}

        # Add missing categories as tag groups
        for category in categories:
            if category not in existing_groups:
                print(f"Creating tag group for category: {category}")
                session.add(TagGroup(name=category))

        session.commit()


def main():
    """Main function to prepare embeddings for categories and tags."""
    # Load categories
    categories_path = "data/categories.yml"
    categories = load_categories(categories_path)

    # Ensure all categories exist as tag groups
    ensure_tag_groups_exist(categories)

    # Create category embeddings
    categories_embeddings_path = "data/category_embeddings.json"
    create_category_embeddings(categories, categories_embeddings_path)

    # Create tag embeddings
    tags_embeddings_path = "data/tag_embeddings.json"
    create_tag_embeddings(tags_embeddings_path)

    print("All embeddings prepared successfully")


if __name__ == "__main__":
    main()
