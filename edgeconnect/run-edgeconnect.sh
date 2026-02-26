#!/bin/bash
# EdgeConnect Docker Setup Script
# Run from: /home/ec2-user/BizObs Generator - Dynatrace AppEngine App/edgeconnect/

set -e

CONTAINER_NAME="edgeconnect-bizobs"
YAML_FILE="$(cd "$(dirname "$0")" && pwd)/edgeConnect.yaml"
IMAGE="dynatrace/edgeconnect:latest"

echo "🔌 EdgeConnect Docker Setup"
echo "================================"

# Check YAML exists
if [ ! -f "$YAML_FILE" ]; then
  echo "❌ edgeConnect.yaml not found at: $YAML_FILE"
  echo "   Copy the YAML from Dynatrace EdgeConnect Settings → Deploy"
  exit 1
fi

# Check for placeholder values
if grep -q '#your' "$YAML_FILE"; then
  echo "❌ edgeConnect.yaml still has placeholder values."
  echo "   Update client_secret and resource before running."
  exit 1
fi

# Install Docker if needed
if ! command -v docker &>/dev/null; then
  echo "📦 Installing Docker..."
  sudo yum install -y docker
  sudo systemctl start docker
  sudo systemctl enable docker
  sudo usermod -aG docker "$(whoami)"
  echo "✅ Docker installed"
fi

# Start Docker if not running
if ! sudo docker info &>/dev/null; then
  echo "🔄 Starting Docker..."
  sudo systemctl start docker
fi

# Stop existing container if running
if sudo docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "🔄 Removing existing container: $CONTAINER_NAME"
  sudo docker stop "$CONTAINER_NAME" 2>/dev/null || true
  sudo docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

# Pull latest image
echo "📥 Pulling $IMAGE..."
sudo docker pull "$IMAGE"

# Run container
echo "🚀 Starting EdgeConnect..."
sudo docker run -d --restart always \
  --name "$CONTAINER_NAME" \
  --network host \
  --mount "type=bind,src=$YAML_FILE,dst=/edgeConnect.yaml" \
  "$IMAGE"

# Check status
sleep 3
if sudo docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
  echo ""
  echo "✅ EdgeConnect is running!"
  echo "   Container: $CONTAINER_NAME"
  echo "   Config:    $YAML_FILE"
  echo ""
  echo "📋 Useful commands:"
  echo "   sudo docker logs $CONTAINER_NAME        # View logs"
  echo "   sudo docker restart $CONTAINER_NAME      # Restart"
  echo "   sudo docker stop $CONTAINER_NAME         # Stop"
  echo ""
  echo "⏳ Waiting for connection (10s)..."
  sleep 10
  echo ""
  echo "📋 Recent logs:"
  sudo docker logs --tail 10 "$CONTAINER_NAME" 2>&1
else
  echo ""
  echo "⚠️  Container started but may have issues. Check logs:"
  echo "   sudo docker logs $CONTAINER_NAME"
fi
