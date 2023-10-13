import pandas as pd
from helper import constance, utils, date_utils, analysis_helper, ticks_helper
from collections import deque
from datetime import datetime, timedelta
import numpy as np
import pytz
import random
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import mplcursors

class AnomalyDetector:
    def __init__(self):
        self.datas = []
        self.ten_minute_data = deque(maxlen=21)  # 20 * 30 seconds = 10 minutes
        self.five_days_data = {}  # 5 days data, key is timestamp, value is deque of data
        self.current_30s_data = []  # current 30 seconds data
        self.current_30s_start_time = None  # start time of the current 30 seconds
        self.last_30s_abnormal_time = None 
        self.anomalies = []
        self.cjl_threshold = 8000
        self.detect_anomaly = False
    
    def print_anomalies(self):
        print(f'Anomalies: {len(self.anomalies)}')
        for anomaly in self.anomalies:
            print(f'{anomaly["code"]} {anomaly["time"]} {anomaly["cjl"]} {anomaly["zxj"]}')

    def process_new_data(self, data):
        self.datas.append(data)

        # Parse time
        data['time'] = datetime.strptime(
            data['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)
        data['anomaly'] = False
        # Calculate the start time of the current 30 seconds
        current_30s_start_time = data['time'].replace(
            second=data['time'].second // 30 * 30, microsecond=0)

        if self.last_30s_abnormal_time == current_30s_start_time:
            data['anomaly'] = True
            return
        
        # Process 30 seconds data
        if self.current_30s_start_time is None or current_30s_start_time > self.current_30s_start_time:
            # Calculate the abnormal，记录过去5天，每天的当前时间的30秒汇总数据
            if self.current_30s_start_time != None and self.current_30s_data:
                summary = {'time': self.current_30s_start_time, 'cjl': sum(
                    [d['cjl'] for d in self.current_30s_data]) / len(self.current_30s_data) * 6}
                self.ten_minute_data.append(summary)
                timestamp = self.current_30s_start_time.time()
                if timestamp not in self.five_days_data:
                    self.five_days_data[timestamp] = deque(maxlen=6)
                self.five_days_data[timestamp].append(summary)

            # TODO Modify the anomaly detection algorithm, add an anomaly object
            if self.current_30s_start_time != None and len(self.ten_minute_data) > 19 and len(self.current_30s_data) > 2:
                past_10_minute_cjl = [d['cjl'] for d in list(self.ten_minute_data)[0:-1]]
                ten_minute_mean = np.mean(past_10_minute_cjl)
                ten_minute_std = np.std(past_10_minute_cjl)
                timestamp = (self.current_30s_start_time).time()
                if timestamp in self.five_days_data and len(self.five_days_data[timestamp]) > 2:
                    past_5_days_cjl = [d['cjl'] for d in list(
                        self.five_days_data[timestamp])[:-1]]
                    five_days_mean = np.mean(past_5_days_cjl)
                    five_days_std = np.std(past_5_days_cjl)

                    last_30s_cjl = sum([d['cjl'] for d in self.current_30s_data]) / len(self.current_30s_data) * 6
                    if abs(last_30s_cjl - ten_minute_mean) > 3 * ten_minute_std and abs(last_30s_cjl - five_days_mean) > 3 * five_days_std and last_30s_cjl > self.cjl_threshold:
                        self.anomalies.append(
                            {'time': self.current_30s_start_time, 'cjl': last_30s_cjl, 'code': data['code'], 'zxj': data['zxj']})
                        
                        data['anomaly'] = True
                        self.detect_anomaly = True
                    else:
                        self.detect_anomaly = False
                        

            # refresh the data
            self.current_30s_data = [data]
            self.current_30s_start_time = current_30s_start_time
        else:
            data['anomaly'] = self.detect_anomaly
            self.current_30s_data.append(data)        

def draw_abnormal(ad, resample_rule='30S'):
    print(f'Anomalies: {len(ad.anomalies)}')
    df = pd.DataFrame(ad.datas)
    df.set_index('time', inplace=True)
    df.index = pd.to_datetime(df.index)
    df.drop(df[df['cjl'] == 0].index, inplace=True)

    # Resampling the data
    df_resampled = df.resample(resample_rule).agg({'cjl': 'sum', 'anomaly': 'any'})

    # Creating the color list
    colors = ['red' if anomaly else 'blue' for anomaly in df_resampled['anomaly']]

    # Using integer sequence for x-axis to ensure bars are continuous
    x = range(len(df_resampled))

    # Create the plot
    fig, ax = plt.subplots(figsize=(12, 6))

    # We use a width slightly less than 1 for the bars to ensure there's a small gap between them
    ax.bar(x, df_resampled['cjl'], color=colors, width=0.8)

    # Set custom ticks to show the dates
    ax.set_xticks(x[::int(len(x)/10)])  # Showing only every 10th date for clarity
    ax.set_xticklabels(df_resampled.index[::int(len(x)/10)].strftime('%Y-%m-%d %H:%M:%S'), rotation=45)

    ax.set_ylabel('CJL')
    ax.set_title(f'CJL over Time Resampled every {resample_rule} with Anomalies Highlighted in Red')

    # Add mplcursors for interactive data
    mplcursors.cursor(hover=True)

    plt.tight_layout()  # Ensure everything fits without overlap
    plt.show()




if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-11-01", "2022-11-05", "rb", span_type)
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    ad = AnomalyDetector()
    for tick in ticks:
        ad.process_new_data(tick)
    
    ad.print_anomalies()
    utils.convert_dic_to_csv("anomalies", ad.datas)
    
    draw_abnormal(ad)

