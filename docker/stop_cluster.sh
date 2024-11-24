#!/bin/bash

# Check if cluster ID is provided
if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <cluster_id>"
    exit 1
fi

CLUSTER_ID=$1

# Colors for output
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

# Function to print in color
function print_color {
  echo -e "${1}${2}${RESET}"
}

print_color "$CYAN" "Stopping Citus Cluster $CLUSTER_ID..."

# Stop all containers related to this cluster
print_color "$YELLOW" "Stopping and removing containers..."
docker-compose -f docker-compose-workers.yml -p "citus_${CLUSTER_ID}" down -v
docker-compose -f docker-compose-master.yml -p "citus_${CLUSTER_ID}" down -v

# Remove residual networks and volumes
print_color "$YELLOW" "Removing residual networks and volumes..."
docker network rm "citus_${CLUSTER_ID}_default" 2>/dev/null
docker volume prune -f

print_color "$GREEN" "Citus Cluster $CLUSTER_ID stopped and cleaned up completely."
