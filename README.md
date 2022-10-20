# 0. Install package
pip install -m ./
# 1. Collection 5s tick data
python3 ./termination/realtime_tick.py

# 2. Setup real time data collection
sudo docker build -t realtime-collector .
sudo docker run --name realtime-collector --network host --restart=unless-stopped -d realtime-collector