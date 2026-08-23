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

# Update Cargo.toml (first version key only, i.e. the [package] one).
# BSD sed silently ignores `0,/re/` ranges, so use awk for portability.
awk -v v="$VERSION" '!done && /^version = /{sub(/"[^"]*"/, "\"" v "\""); done=1} {print}' \
	src-tauri/Cargo.toml >src-tauri/Cargo.toml.tmp
mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml

echo "Updated versions:"
grep '"version"' src-tauri/tauri.conf.json
grep '^version' src-tauri/Cargo.toml | head -1

echo "Committing version bump..."
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml
if git diff --cached --quiet; then
	echo "  versions already at $VERSION, nothing to commit"
else
	git commit -m "chore: bump version to $VERSION"
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
	echo "Tag $TAG already exists locally, reusing it"
else
	echo "Creating tag: $TAG"
	git tag "$TAG"
fi

echo "Pushing commit and tag to origin..."
git push origin HEAD
git push origin "$TAG"

echo "Done! Tag $TAG created and pushed. Watch the build at:"
echo "  https://github.com/jesi-rgb/rolloc/actions"
