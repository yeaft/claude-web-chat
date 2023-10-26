#!/bin/bash

sudo docker stop realtime-collector && sudo docker rm realtime-collector && sudo docker image rm realtime-collector
sudo docker build -t realtime-collector --no-cache . && sudo docker run --name realtime-collector --network host --restart=unless-stopped -d realtime-collector