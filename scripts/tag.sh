#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
	echo "Usage: ./scripts/tag.sh <tag>"
	echo "Example: ./scripts/tag.sh v0.2.4"
	exit 1
fi

TAG="$1"

echo "Creating tag: $TAG"
git tag "$TAG"

echo "Pushing tag to origin..."
git push origin "$TAG"

echo "Done! Tag $TAG created and pushed."
