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
        self.anomalies = []
        self.anomalies_time = None

    def process_new_data(self, data):
        self.datas.append(data)

        # Parse time
        data['time'] = datetime.strptime(data['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)
        data['anomaly'] = False
        # Calculate the start time of the current 30 seconds
        current_30s_start_time = data['time'].replace(
            second=data['time'].second // 30 * 30, microsecond=0)
                    
        # Process 30 seconds data
        if self.current_30s_start_time is None or current_30s_start_time > self.current_30s_start_time:
            # If the current 30 seconds data is full or it's the first data, process it
            if self.current_30s_data:
                # Calculate the summary of the last 30 seconds
                summary = {'time': self.current_30s_start_time, 'cjl': sum(
                    [d['cjl'] for d in self.current_30s_data]) / len(self.current_30s_data) * 6}

                # Add summary to ten minute data
                self.ten_minute_data.append(summary)

                # Add summary to five days data
                timestamp = self.current_30s_start_time.time()  # get the time of the day
                if timestamp not in self.five_days_data:
                    # if the timestamp is not in the dict, create a new deque
                    self.five_days_data[timestamp] = deque(maxlen=6)
                self.five_days_data[timestamp].append(summary)

            # Reset the current 30 seconds data
            self.current_30s_data = [data]
            self.current_30s_start_time = current_30s_start_time

        else:
            # If the current 30 seconds data is not full, add the new data to it
            self.current_30s_data.append(data)

        # Calculate anomaly
        if not self.anomalies_time or data['time'] - self.anomalies_time > timedelta(minutes=10):
            if len(self.ten_minute_data) > 19:  # to avoid zero division error
                # Calculate mean and standard deviation of the last 10 minutes' data
                past_10_minute_cjl = [d['cjl'] for d in list(self.ten_minute_data)[0:-1]]
                ten_minute_mean = np.mean(past_10_minute_cjl)
                ten_minute_std = np.std(past_10_minute_cjl)

                # Calculate mean and standard deviation of the last 5 days' same time data
                # get the time of the day of the last data
                timestamp = (self.current_30s_start_time -
                            timedelta(seconds=30)).time()
                # to avoid zero division error
                if timestamp in self.five_days_data and len(self.five_days_data[timestamp]) > 2:
                    past_5_days_cjl = [d['cjl'] for d in list(self.five_days_data[timestamp])[:-1]]
                    five_days_mean = np.mean(past_5_days_cjl)
                    five_days_std = np.std(past_5_days_cjl)

                    # If the cjl of the last 30 seconds data is more than 1 standard deviation away from the mean, mark it as anomaly
                    last_30s_cjl = sum(
                        [d['cjl'] for d in self.current_30s_data]) / len(self.current_30s_data) * 6
                    if abs(last_30s_cjl - ten_minute_mean) > 3 * ten_minute_std and abs(last_30s_cjl - five_days_mean) > 3 * five_days_std:
                        self.anomalies.append(
                            {'time': self.current_30s_start_time, 'cjl': last_30s_cjl})
                        data['anomaly'] = True
                        self.anomalies_time = data['time']
                    

def test():
    # 创建一个AnomalyDetector实例
    ad = AnomalyDetector()

    # 用于生成测试数据的函数


    def generate_test_data(start_time, num_points, cjl_initial=100):
        time = start_time
        cjl = cjl_initial
        for _ in range(num_points):
            price = random.uniform(2000, 2100)  # 限制价格变动范围在[2000, 2100]之间
            cjl += random.uniform(-10, 10)  # 限制成交量变动范围在[-10, 10]之间
            yield {'time': time.strftime('%Y-%m-%d %H:%M:%S.%f'), 'price': price, 'cjl': cjl}
            time += timedelta(seconds=5)


    # 测试数据：生成一天的随机数据，每五秒一个数据点
    test_data = list(generate_test_data(datetime.now(), 24*60*60//5))

    # 处理测试数据
    for data in test_data:
        ad.process_new_data(data)
    
    draw_abnormal(ad)


def draw_abnormal(ad):
    print(f'Anomalies: {len(ad.anomalies)}')
    # Create DataFrame
    df = pd.DataFrame(ad.datas)

    # Set "time" as index and resample to 30s
    df.set_index('time', inplace=True)
    df.index = pd.to_datetime(df.index)
    df.drop(df[df['cjl'] == 0].index, inplace=True)

    # Create color list
    colors = ['blue' if not ad.datas[i]['anomaly'] else 'red' for i in range(len(df))]

    # Plot CJL as bar
    fig, ax = plt.subplots()

    # Convert the index to a sequence of integers
    x = np.arange(len(df.index))
    ax.set_xlim(xmin=0, xmax=len(x))

    # Now use the integer sequence as x-values for the plot
    bars = ax.bar(x, df['cjl'], color=colors, label='CJL')

    # Configure x-axis
    ax.xaxis.set_major_locator(plt.MaxNLocator(nbins=10))
    ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda val, pos: df.index[min(
        int(round(val)), len(df.index)-1)].strftime('%Y-%m-%d %H:%M:%S')))


    ax.set_ylim(ymin=0, ymax=20000)

    print(f'load points:  {len(bars.patches)}')
    print(f'colors:  {len(colors)}')

    # Add mplcursors
    crs = mplcursors.cursor(hover=True)
    @crs.connect("add")
    def on_add(sel):
        x, y = sel.target
        date = df.index[int(x)].strftime('%Y-%m-%d %H:%M:%S')
        text = f"Time: {date}, CJL: {y}"
        sel.annotation.set_text(text)

    # Show the plot
    plt.gcf().autofmt_xdate()
    plt.legend()
    plt.show()

if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-11-01", "2022-11-12", "rb", span_type)
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    ad = AnomalyDetector()
    for tick in ticks:
        ad.process_new_data(tick)
    
    draw_abnormal(ad)

