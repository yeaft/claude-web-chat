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
        self.last_30s_start_time = None  # start time of the current 30 seconds
        self.anomaly = None
        self.anomalies = []
        self.cjl_threshold = 8000
    
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

        # Process 30 seconds data
        if self.current_30s_start_time is None or current_30s_start_time > self.current_30s_start_time:
            # Calculate the abnormal
            if self.current_30s_data:
                summary = {'time': self.current_30s_start_time, 'cjl': sum(
                    [d['cjl'] for d in self.current_30s_data]) / len(self.current_30s_data) * 6}
                self.ten_minute_data.append(summary)
                timestamp = self.current_30s_start_time.time()
                if timestamp not in self.five_days_data:
                    self.five_days_data[timestamp] = deque(maxlen=6)
                self.five_days_data[timestamp].append(summary)

            # TODO Modify the anomaly detection algorithm, add an anomaly object
            if not self.anomaly:
                if len(self.ten_minute_data) > 19:
                    past_10_minute_cjl = [d['cjl']
                                          for d in list(self.ten_minute_data)[0:-1]]
                    ten_minute_mean = np.mean(past_10_minute_cjl)
                    ten_minute_std = np.std(past_10_minute_cjl)
                    timestamp = (self.current_30s_start_time -
                                 timedelta(seconds=30)).time()
                    if timestamp in self.five_days_data and len(self.five_days_data[timestamp]) > 2:
                        past_5_days_cjl = [d['cjl'] for d in list(
                            self.five_days_data[timestamp])[:-1]]
                        five_days_mean = np.mean(past_5_days_cjl)
                        five_days_std = np.std(past_5_days_cjl)

                        last_30s_cjl = sum(
                            [d['cjl'] for d in self.current_30s_data]) / len(self.current_30s_data) * 6
                        if not self.previous_anomaly and abs(last_30s_cjl - ten_minute_mean) > 3 * ten_minute_std and abs(last_30s_cjl - five_days_mean) > 3 * five_days_std and last_30s_cjl > self.cjl_threshold:
                            self.anomalies.append(
                                {'time': self.current_30s_start_time, 'cjl': last_30s_cjl, 'code': data['code'], 'zxj': data['zxj']})
                            data['anomaly'] = True
                            self.previous_anomaly = True
                            self.anomalies_time = data['time']
                        elif self.previous_anomaly and abs(last_30s_cjl - ten_minute_mean) <= 3 * ten_minute_std and abs(last_30s_cjl - five_days_mean) <= 3 * five_days_std:
                            self.previous_anomaly = False

            # refresh the data
            self.current_30s_data = [data]
            self.current_30s_start_time = current_30s_start_time
        else:
            self.current_30s_data.append(data)        


def draw_abnormal(ad):
    print(f'Anomalies: {len(ad.anomalies)}')
    df = pd.DataFrame(ad.datas)
    df.set_index('time', inplace=True)
    df.index = pd.to_datetime(df.index)
    df.drop(df[df['cjl'] == 0].index, inplace=True)

    # Creating the color list for the all data plot
    colors_all = ['blue' if not ad.datas[i]['anomaly']
                  else 'red' for i in range(len(df))]

    # Creating the color list for the anomalies plot
    df_anomalies = df[df['anomaly'] == True]
    colors_anomalies = ['red' for _ in range(len(df_anomalies))]

    fig, axs = plt.subplots(2, 1, sharex=True, figsize=(10, 10))

    # Plot all data
    x_all = np.arange(len(df.index))
    axs[0].set_xlim(xmin=0, xmax=len(x_all))
    bars_all = axs[0].bar(x_all, df['cjl'], color=colors_all, label='CJL')
    axs[0].set_ylim(ymin=0, ymax=20000)
    axs[0].xaxis.set_major_locator(plt.MaxNLocator(nbins=10))
    axs[0].xaxis.set_major_formatter(plt.FuncFormatter(lambda val, pos: df.index[min(
        int(round(val)), len(df.index)-1)].strftime('%Y-%m-%d %H:%M:%S')))

    # Plot anomalies
    x_anomalies = np.arange(len(df_anomalies.index))
    bars_anomalies = axs[1].bar(
        x_anomalies, df_anomalies['cjl'], color=colors_anomalies, label='CJL')
    axs[1].set_ylim(ymin=0, ymax=20000)
    axs[1].xaxis.set_major_locator(plt.MaxNLocator(nbins=10))
    axs[1].xaxis.set_major_formatter(plt.FuncFormatter(lambda val, pos: df_anomalies.index[min(
        int(round(val)), len(df_anomalies.index)-1)].strftime('%Y-%m-%d %H:%M:%S')))

    # Add mplcursors
    crs = mplcursors.cursor([bars_all, bars_anomalies], hover=True)
    @crs.connect("add")
    def on_add(sel):
        x, y = sel.target
        if sel.artist == bars_all:
            date = df.index[int(x)].strftime('%Y-%m-%d %H:%M:%S')
        else:
            date = df_anomalies.index[int(x)].strftime('%Y-%m-%d %H:%M:%S')
        text = f"Time: {date}, CJL: {y}"
        sel.annotation.set_text(text)

    # Show the plot
    plt.gcf().autofmt_xdate()
    axs[0].legend()
    axs[1].legend()
    plt.show()

if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-11-01", "2022-11-12", "rb", span_type)
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    ad = AnomalyDetector()
    for tick in ticks:
        ad.process_new_data(tick)
    
    ad.print_anomalies()
    
    draw_abnormal(ad)

