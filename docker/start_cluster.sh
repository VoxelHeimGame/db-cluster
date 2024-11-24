#!/bin/bash

# Check if cluster ID and number of workers are provided
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <cluster_id> <workers_count>"
    exit 1
fi

CLUSTER_ID=$1
WORKERS_COUNT=$2

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

print_color "$CYAN" "🚀 Starting the Citus Cluster $CLUSTER_ID..."

# Start the master and manager containers
print_color "$YELLOW" "⚙️ Starting the master and manager containers..."
docker-compose -f docker-compose-master.yml -p "citus_${CLUSTER_ID}" up -d

# Wait until the master container is ready
MASTER_CONTAINER="citus_${CLUSTER_ID}_master"
print_color "$CYAN" "⏳ Waiting for the master container to be ready..."
until docker exec "$MASTER_CONTAINER" pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done

# Start the worker containers
print_color "$YELLOW" "⚙️ Starting $WORKERS_COUNT worker(s)..."
docker-compose -f docker-compose-workers.yml -p "citus_${CLUSTER_ID}" up -d --scale worker=$WORKERS_COUNT

# Obtain the IPs of the workers
print_color "$CYAN" "🔍 Gathering worker IPs..."
WORKER_IPS=()
for WORKER in $(docker ps --filter "label=com.citusdata.role=Worker" --filter "name=citus_${CLUSTER_ID}" --format "{{.Names}}"); do
  WORKER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$WORKER")
  WORKER_IPS+=("$WORKER_IP")
done

# Register the workers to the master container
print_color "$YELLOW" "📝 Registering workers on the master..."
for WORKER_IP in "${WORKER_IPS[@]}"; do
  print_color "$CYAN" "🌐 Registering worker $WORKER_IP..."
  
  sleep 10 # Wait before attempting registration
  # Connect to the master container and run the query to add the worker node
  docker exec "$MASTER_CONTAINER" psql -U postgres -d postgres -c "SELECT citus_add_node('$WORKER_IP', 5432);"

  # Check if the query was successful
  if [ $? -eq 0 ]; then
    print_color "$GREEN" "✔️ Worker $WORKER_IP registered successfully."
  else
    print_color "$RED" "❌ Failed to register worker $WORKER_IP."
  fi
done

# Confirm the workers were added successfully
print_color "$CYAN" "✅ Confirming worker additions..."
docker exec "$MASTER_CONTAINER" psql -U postgres -d postgres -c "SELECT * FROM pg_dist_node;"

print_color "$GREEN" "🎉 Citus Cluster $CLUSTER_ID started successfully."

