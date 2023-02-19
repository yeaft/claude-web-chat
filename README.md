# 0. Install package
pip install -m ./
# 1. Collection 5s tick data
python3 ./termination/realtime_tick.py

# 2. Setup real time data collection
sudo docker build -t realtime-collector .
sudo docker build -t realtime-collector --no-cache .
sudo docker run --name realtime-collector --network host --restart=unless-stopped -d realtime-collector

# 3. Stop and remove image
sudo docker stop realtime-collector && sudo docker rm realtime-collector && sudo docker image rm realtime-collector

# 4. Remove all useless time data
db.realTimeTick.deleteMany({"type":"rb", "time": { "$regex": ".* 23.*|.* 00.*|.* 01.*"}})