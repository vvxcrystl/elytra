"""Training-only helper. pip install pyarrow; datasets never belong in Git.

The CC0 Civil Comments release is the Jigsaw Unintended Bias dataset.
Exports the first parquet shard by default (~185 MiB download, 902,437 rows).
"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

import pyarrow.parquet as pq

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path, help="Use a directory outside the repository")
parser.add_argument("--shards", type=int, choices=[1, 2], default=1)
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=True)
checksums = ["c20f01c3aecbdd942886cacb0ee67e995df33bc712a622fde75927ed3d6ccefe", "a76af69d7b24758bc38b196bc422d4767935c1dd7d3c1465554649c546d99ccb"]
with (args.directory / "civil-comments.jsonl").open("w") as output:
    for shard in range(args.shards):
        name = f"{shard:04d}.parquet"
        path = args.directory / name
        if not path.exists():
            urllib.request.urlretrieve(
                f"https://huggingface.co/datasets/google/civil_comments/resolve/refs%2Fconvert%2Fparquet/default/train/{name}", path)
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != checksums[shard]:
                raise ValueError(f"Dataset checksum mismatch: {path}")
        for batch in pq.ParquetFile(path).iter_batches(batch_size=1024):
            for row in batch.to_pylist():
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
print(args.directory / "civil-comments.jsonl")
