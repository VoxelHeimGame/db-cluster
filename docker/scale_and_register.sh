#!/bin/bash

WORKERS_COUNT=${1:-2}

echo "Escalando el clúster a $WORKERS_COUNT workers..."
docker-compose up -d --scale worker=$WORKERS_COUNT --no-recreate

echo "Registrando nuevos workers en el maestro..."
MASTER_CONTAINER="docker_master"
EXISTING_WORKERS=$(docker exec "$MASTER_CONTAINER" psql -U postgres -t -c "SELECT nodename FROM pg_dist_node;")

for WORKER in $(docker ps --filter "label=com.citusdata.role=Worker" --format "{{.Names}}"); do
  WORKER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$WORKER")
  if [[ "$EXISTING_WORKERS" != *"$WORKER_IP"* ]]; then
    echo "Añadiendo worker $WORKER ($WORKER_IP) al clúster..."
    docker exec "$MASTER_CONTAINER" psql -U postgres -c "SELECT * FROM citus_add_node('$WORKER_IP', 5432);"
  else
    echo "Worker $WORKER ($WORKER_IP) ya registrado en el clúster."
  fi
done
