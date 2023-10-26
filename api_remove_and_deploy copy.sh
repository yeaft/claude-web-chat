#!/bin/bash

sudo docker stop realtime-server && sudo docker rm realtime-server && sudo docker image rm realtime-server
sudo docker build -t realtime-server -f ServerDockerFile --no-cache . && sudo docker run --name realtime-server --network host --restart=unless-stopped -d realtime-server -p 80:80