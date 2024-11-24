#!/bin/bash

# Check if cluster ID and number of workers to keep are provided
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <cluster_id> <workers_to_keep>"
    exit 1
fi

CLUSTER_ID=$1
WORKERS_TO_KEEP=$2

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

# Master container name
MASTER_CONTAINER="citus_${CLUSTER_ID}_master"

# Function to print in color
function print_color {
  echo -e "${1}${2}${RESET}"
}

# Function to wait until the container is ready
function wait_for_container {
  local container_name=$1
  print_color "$CYAN" "⏳ Waiting for $container_name to be ready..."
  until docker exec "$container_name" pg_isready -U postgres > /dev/null 2>&1; do
    sleep 1
  done
}

# Get the list of active workers (based on label and cluster ID)
print_color "$CYAN" "🔍 Gathering list of active workers..."
ACTIVE_WORKERS=()
for WORKER in $(docker ps --filter "label=com.citusdata.role=Worker" --filter "name=citus_${CLUSTER_ID}" --format "{{.Names}}"); do
  WORKER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$WORKER")
  ACTIVE_WORKERS+=("$WORKER_IP")
done

# Sort the workers by IP (ascending order)
IFS=$'\n' sorted_active_workers=($(sort <<<"${ACTIVE_WORKERS[*]}"))
unset IFS

# Determine which workers to remove (if there are more than the number to keep)
WORKERS_TO_REMOVE=()
for ((i=WORKERS_TO_KEEP; i<${#sorted_active_workers[@]}; i++)); do
  WORKERS_TO_REMOVE+=("${sorted_active_workers[$i]}")
done

# If there are no workers to remove, exit
if [ ${#WORKERS_TO_REMOVE[@]} -eq 0 ]; then
  print_color "$GREEN" "✔️ No workers need to be removed. All workers are within the allowed limit."
  exit 0
fi

# Remove the workers from the database (Citus cluster)
print_color "$YELLOW" "📝 Removing worker(s) from the database..."
for WORKER_IP in "${WORKERS_TO_REMOVE[@]}"; do
  print_color "$CYAN" "🌐 Removing worker $WORKER_IP from the Citus cluster..."
  docker exec "$MASTER_CONTAINER" psql -U postgres -d postgres -c "SELECT citus_remove_node('$WORKER_IP', 5432);"
  
  # Check if the query was successful
  if [ $? -eq 0 ]; then
    print_color "$GREEN" "✔️ Worker $WORKER_IP removed from the Citus cluster."
  else
    print_color "$RED" "❌ Failed to remove worker $WORKER_IP from the Citus cluster."
  fi
done

# Now remove the workers from Docker
print_color "$YELLOW" "🧹 Removing worker(s) from Docker..."
for WORKER_IP in "${WORKERS_TO_REMOVE[@]}"; do
  # Find the corresponding Docker container based on IP
  WORKER_CONTAINER=$(docker ps --filter "label=com.citusdata.role=Worker" --filter "name=citus_${CLUSTER_ID}" --format "{{.Names}}" | while read name; do
    CONTAINER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
    if [[ "$CONTAINER_IP" == "$WORKER_IP" ]]; then
      echo "$name"
    fi
  done)
  
  if [ -n "$WORKER_CONTAINER" ]; then
    print_color "$CYAN" "🗑️ Stopping and removing worker container $WORKER_CONTAINER..."
    docker stop "$WORKER_CONTAINER" && docker rm "$WORKER_CONTAINER"
    print_color "$GREEN" "✔️ Worker container $WORKER_CONTAINER removed."
  else
    print_color "$RED" "❌ No Docker container found for IP $WORKER_IP."
  fi
done

# Confirm the removal of workers from the Citus cluster
print_color "$CYAN" "✅ Confirming the removal of workers..."
docker exec "$MASTER_CONTAINER" psql -U postgres -d postgres -c "SELECT * FROM pg_dist_node;"

print_color "$GREEN" "🎉 Workers removed successfully from both Docker and the Citus cluster $CLUSTER_ID."

