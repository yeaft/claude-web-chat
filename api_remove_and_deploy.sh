#!/bin/bash

sudo docker stop realtime-server && sudo docker rm realtime-server && sudo docker image rm realtime-server
sudo docker build -t realtime-server -f ServerDockerFile . && sudo docker run --name realtime-server --network host -p 8080:8080 --restart=unless-stopped -d realtime-server 