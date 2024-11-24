#!/bin/bash

# Check if cluster ID and number of workers are provided
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <cluster_id> <workers_count>"
    exit 1
fi

CLUSTER_ID=$1
WORKERS_COUNT=$2

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

# Start the worker container(s)
print_color "$YELLOW" "⚙️ Starting $WORKERS_COUNT worker(s)..."
docker-compose -f docker-compose-workers.yml -p "citus_${CLUSTER_ID}" up -d --scale worker=$WORKERS_COUNT

# Obtain the IPs of the new workers
print_color "$CYAN" "🔍 Gathering IPs of the new worker(s)..."
WORKER_IPS=()
for WORKER in $(docker ps --filter "label=com.citusdata.role=Worker" --filter "name=citus_${CLUSTER_ID}" --format "{{.Names}}"); do
  WORKER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$WORKER")
  WORKER_IPS+=("$WORKER_IP")
done

# Register the worker(s) to the master
print_color "$YELLOW" "📝 Registering worker(s) to the master..."
for WORKER_IP in "${WORKER_IPS[@]}"; do
  print_color "$CYAN" "🌐 Registering worker $WORKER_IP..."
  
  # Wait before attempting registration
  sleep 5

  # Connect to the master container and execute the SQL query to add the worker node
  docker exec "$MASTER_CONTAINER" psql -U postgres -d postgres -c "SELECT citus_add_node('$WORKER_IP', 5432);"

  # Check if the query was successful
  if [ $? -eq 0 ]; then
    print_color "$GREEN" "✔️ Worker $WORKER_IP registered successfully."
  else
    print_color "$RED" "❌ Failed to register worker $WORKER_IP."
  fi
done

# Confirm the addition of the worker(s)
print_color "$CYAN" "✅ Confirming worker addition..."
docker exec "$MASTER_CONTAINER" psql -U postgres -d postgres -c "SELECT * FROM pg_dist_node;"

print_color "$GREEN" "🎉 Worker(s) added and registered to the Citus cluster $CLUSTER_ID successfully."
