#!/bin/bash
# Build script — copies frontend files into frontend/ directory for serving
# Run this before deploying to Railway

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

echo "Building frontend..."

# Clean and recreate
rm -rf "$FRONTEND_DIR"
mkdir -p "$FRONTEND_DIR/components" "$FRONTEND_DIR/modules" "$FRONTEND_DIR/data"

# Copy frontend files
cp "$SCRIPT_DIR/index.html" "$FRONTEND_DIR/"
cp "$SCRIPT_DIR/router.js" "$FRONTEND_DIR/"
cp "$SCRIPT_DIR/theme.js" "$FRONTEND_DIR/"
cp "$SCRIPT_DIR/app.js" "$FRONTEND_DIR/"
cp "$SCRIPT_DIR/components/"*.js "$FRONTEND_DIR/components/"
cp "$SCRIPT_DIR/modules/"*.js "$FRONTEND_DIR/modules/"
cp "$SCRIPT_DIR/data/"*.js "$FRONTEND_DIR/data/"

echo "Frontend built to $FRONTEND_DIR"
echo "Files: $(find "$FRONTEND_DIR" -name '*.js' -o -name '*.html' | wc -l)"
