#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
	echo "Usage: ./scripts/tag.sh <tag>"
	echo "Example: ./scripts/tag.sh v0.5.0"
	exit 1
fi

TAG="$1"
VERSION="${TAG#v}"

# Validate semver (MAJOR.MINOR.PATCH)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Error: tag must be a semver string like v1.2.3 (got '$TAG')"
	exit 1
fi

echo "Bumping version to $VERSION..."

# Update tauri.conf.json
if [[ "$OSTYPE" == "darwin"* ]]; then
	sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
else
	sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
fi

# Update Cargo.toml (package version only, not dependency versions)
if [[ "$OSTYPE" == "darwin"* ]]; then
	sed -i '' "0,/^version = /s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
else
	sed -i "0,/^version = /s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
fi

echo "Updated versions:"
grep '"version"' src-tauri/tauri.conf.json
grep '^version' src-tauri/Cargo.toml | head -1

echo "Committing version bump..."
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore: bump version to $VERSION"

echo "Creating tag: $TAG"
git tag "$TAG"

echo "Pushing commit and tag to origin..."
git push origin HEAD
git push origin "$TAG"

echo "Done! Tag $TAG created and pushed. Watch the build at:"
echo "  https://github.com/jesi-rgb/rolloc/actions"
