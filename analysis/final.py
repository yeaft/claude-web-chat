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
import random
from collections import deque
from datetime import datetime, timedelta
import matplotlib.pyplot as plt
import mplcursors
import matplotlib.dates as mdates
import heapq
from helper import constance, utils, date_utils, analysis_helper, ticks_helper
import pytz


class DataProcessor:
    def __init__(self, past_x_hour=1, next_x_min=3, extreme_point_threshold=0.02, check_column_name="zxj"):
        self.data = []
        self.candidate_points = []
        self.extreme_points = []
        self.error_points = []
        self.past_x_hours = past_x_hour
        self.past_x_hours_num = int(past_x_hour * 3600 / 5)
        self.next_x_min = next_x_min
        self.next_x_min_num = int(next_x_min * 60 / 5)
        self.extreme_point_threshold = extreme_point_threshold
        self.check_column_name = check_column_name

    def print_extreme_points(self):

        min_correct_count = len(
            [extreme_point for extreme_point in self.extreme_points if extreme_point["extreme_type"] == "min"])
        max_correct_count = len(
            [extreme_point for extreme_point in self.extreme_points if extreme_point["extreme_type"] == "max"])
        min_error_count = len(
            [error_point for error_point in self.error_points if error_point["extreme_type"] == "min"])
        max_error_count = len(
            [error_point for error_point in self.error_points if error_point["extreme_type"] == "max"])

        utils.log(f"{self.past_x_hours}-{self.next_x_min}: All count {len(self.extreme_points)+len(self.error_points)}, Correct rate: {round(len(self.extreme_points) * 100.00/(len(self.extreme_points)+len(self.error_points)), 2)}, min count: {min_correct_count+min_error_count}, max count: {max_correct_count+max_error_count}, min rate: {round(min_correct_count*100.00/(min_correct_count+min_error_count), 2)}, max rate: {round(max_correct_count*100.00/(max_correct_count+max_error_count), 2)}")

        for extreme_point in self.extreme_points:
            utils.log(
                f'{self.past_x_hours}-{self.next_x_min}: Correct {extreme_point["code"]} {extreme_point["time"]} {extreme_point["extreme_type"]} {extreme_point[self.check_column_name]}')

        for error_point in self.error_points:
            utils.log(
                f'{self.past_x_hours}-{self.next_x_min}: Error {error_point["code"]} {error_point["time"]} {error_point["extreme_type"]} {error_point[self.check_column_name]}')

    def process_new_data(self, tick):
        self.data.append(tick)

        # Parse time
        if type(tick['time']) == str:
            tick['time'] = datetime.strptime(
                tick['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)
        # print(f"{type(data['time'])}")

        n = len(self.data)
        # We don't have enough data for a 2-hour window and additional 3 minutes
        if n < self.past_x_hours_num+self.next_x_min_num:
            return
        self.update_extreme_points(n)

    def update_extreme_points(self, n):
        check_point = self.data[n-self.next_x_min_num]
        last_2_hours_and_next_x_min_data = self.data[n -
                                                     self.past_x_hours_num-self.next_x_min_num:n]

        if self.extreme_points:
            last_extreme_value = self.extreme_points[-1][self.check_column_name]
            last_extreme_type = self.extreme_points[-1]['extreme_type']
            if (last_extreme_type == "max" and last_extreme_value - check_point[self.check_column_name] / last_extreme_value < self.extreme_point_threshold) \
                    or (last_extreme_type == "min" and check_point[self.check_column_name] - last_extreme_value / last_extreme_value < self.extreme_point_threshold):
                return  # The value difference is less than 2%, ignore this point

        max_value_point = max(
            last_2_hours_and_next_x_min_data, key=lambda x: x[self.check_column_name])
        min_value_point = min(
            last_2_hours_and_next_x_min_data, key=lambda x: x[self.check_column_name])

        if check_point[self.check_column_name] == max_value_point[self.check_column_name]:
            check_point['extreme_type'] = 'max'
            self.candidate_points.append(check_point)
        elif check_point[self.check_column_name] == min_value_point[self.check_column_name]:
            check_point['extreme_type'] = 'min'
            self.candidate_points.append(check_point)

        for candidate in self.candidate_points.copy():
            if candidate['time'] < self.data[-1]['time'] - timedelta(hours=self.past_x_hours):
                self.candidate_points.remove(candidate)
                next_x_hours_data = self.data[n-self.past_x_hours_num:n]
                max_value_point = max(
                    next_x_hours_data, key=lambda x: x[self.check_column_name])
                min_value_point = min(
                    next_x_hours_data, key=lambda x: x[self.check_column_name])

                if (candidate['extreme_type'] == 'max' and candidate[self.check_column_name] >= max_value_point[self.check_column_name]) or \
                   (candidate['extreme_type'] == 'min' and candidate[self.check_column_name] <= min_value_point[self.check_column_name]):
                    self.extreme_points.append(candidate)
                else:
                    self.error_points.append(candidate)


def draw_image(dps, ticks, check_column_name="zxj"):

    # 提取时间和价格
    times = [mdates.date2num(data['time']) for data in ticks]
    values = [data[check_column_name] for data in ticks]

    fig, axs = plt.subplots(len(dps), 1, figsize=(10, 15))

    for i, dp in enumerate(dps):
        axs[i].plot_date(times, values, fmt='-', label=check_column_name)
        extreme_times = [mdates.date2num(point['time'])
                         for point in dp.extreme_points]
        extreme_values = [point[check_column_name]
                          for point in dp.extreme_points]
        axs[i].scatter(extreme_times, extreme_values,
                       color='blue', label='Extreme Points')
        candidate_times = [mdates.date2num(
            point['time']) for point in dp.candidate_points]
        candidate_values = [point[check_column_name]
                            for point in dp.candidate_points]
        axs[i].scatter(candidate_times, candidate_values,
                       color='green', label='Candidate Points')
        error_times = [mdates.date2num(point['time'])
                       for point in dp.error_points]
        error_values = [point[check_column_name] for point in dp.error_points]
        axs[i].scatter(error_times, error_values,
                       color='red', label='Error Points')

        # 添加标题
        axs[i].set_title(f'{dp.past_x_hours} hours range - {dp.next_x_min} mins check - right rate: {round(len(dp.extreme_points) * 100 / (len(dp.extreme_points) + len(dp.error_points)), 2)}%, extreme num: {len(dp.extreme_points)}')

    plt.subplots_adjust(hspace=0.5)
    plt.show()


if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-12-15", "2023-01-01", "rb", span_type)
    check_column_name = "ccl"
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    # 创建一个DataProcessor实例
    # dps = [DataProcessor(
    #     2, 20, check_column_name=check_column_name), DataProcessor(3, 20, check_column_name=check_column_name), DataProcessor(3, 30, check_column_name=check_column_name)]

    dps = [DataProcessor(3, 20, check_column_name=check_column_name), DataProcessor(
        3, 30, check_column_name=check_column_name)]

    # 处理测试数据
    for data in ticks:
        for dp in dps:
            dp.process_new_data(data)

    for dp in dps:
        dp.print_extreme_points()

    draw_image(dps, ticks, check_column_name)




class AnomalyDetector:
    def __init__(self):
        self.datas = []
        self.ten_minute_data = deque(maxlen=21)  # 20 * 30 seconds = 10 minutes
        self.five_days_data = {}  # 5 days data, key is timestamp, value is deque of data
        self.current_30s_data = []  # current 30 seconds data
        self.current_30s_start_time = None  # start time of the current 30 seconds
        self.anomalies = []
        self.anomalies_time = None
        self.previous_anomaly = False
        self.cjl_threshold = 8000

    def print_anomalies(self):
        print(f'Anomalies: {len(self.anomalies)}')
        for anomaly in self.anomalies:
            print(
                f'{anomaly["code"]} {anomaly["time"]} {anomaly["cjl"]} {anomaly["zxj"]}')

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
            if self.current_30s_data:
                summary = {'time': self.current_30s_start_time, 'cjl': sum(
                    [d['cjl'] for d in self.current_30s_data]) / len(self.current_30s_data) * 6}
                self.ten_minute_data.append(summary)
                timestamp = self.current_30s_start_time.time()
                if timestamp not in self.five_days_data:
                    self.five_days_data[timestamp] = deque(maxlen=6)
                self.five_days_data[timestamp].append(summary)

            self.current_30s_data = [data]
            self.current_30s_start_time = current_30s_start_time
        else:
            self.current_30s_data.append(data)

        if not self.anomalies_time or data['time'] - self.anomalies_time > timedelta(minutes=10):
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

    # draw_abnormal(ad)
