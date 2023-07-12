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
    def __init__(self, past_x_hour = 1, next_x_min=3, extreme_point_threshold=0.02, check_column_name="zxj"):
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
        for extreme_point in self.extreme_points:
            print(
                f'{self.past_x_hours}-{self.next_x_min}: Correct {extreme_point["time"]} {extreme_point["extreme_type"]} {extreme_point[self.check_column_name]}')
            
        for error_point in self.error_points:
            print(
                f'{self.past_x_hours}-{self.next_x_min}: Error {error_point["time"]} {error_point["extreme_type"]} {error_point[self.check_column_name]}')
        
        print(f'{self.past_x_hours}-{self.next_x_min}: Correct {len(self.extreme_points)}, Error {len(self.error_points)}, Correct rate: {round(len(self.extreme_points) * 100.00/(len(self.extreme_points)+len(self.error_points)), 2)}')
        

    def process_new_data(self, tick):
        self.data.append(tick)

        # Parse time
        if type(tick['time']) == str:
            tick['time'] = datetime.strptime(
                tick['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)
        # print(f"{type(data['time'])}")
        
        n = len(self.data)
        if n < self.past_x_hours_num+self.next_x_min_num:  # We don't have enough data for a 2-hour window and additional 3 minutes
            return
        self.update_extreme_points(n)

    def update_extreme_points(self, n):
        check_point = self.data[n-self.next_x_min_num]
        last_2_hours_and_next_x_min_data = self.data[n-self.past_x_hours_num-self.next_x_min_num:n]
        
        if self.extreme_points:
            last_extreme_value = self.extreme_points[-1][self.check_column_name]
            last_extreme_type = self.extreme_points[-1]['extreme_type']
            if (last_extreme_type == "max" and last_extreme_value - check_point[self.check_column_name] / last_extreme_value < self.extreme_point_threshold) \
              or (last_extreme_type == "min" and check_point[self.check_column_name] - last_extreme_value / last_extreme_value < self.extreme_point_threshold) :
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

def test(dps, test_data, check_column_name="zxj"):

    # 用于生成测试数据的函数
    def generate_test_data(start_time, num_points, value_initial=2000):
        time = start_time
        value = value_initial
        for _ in range(num_points):
            ccl = random.uniform(0, 100)
            value += random.uniform(-2, 2)  # 限制价格变动范围在[-2, 2]之间
            yield {'time': time, 'ccl': ccl, check_column_name: value}
            time += timedelta(seconds=5)


    # 测试数据：生成2小时的随机数据，每五秒一个数据点，总共1440个数据点
    test_data = list(generate_test_data(datetime.now(), 20000))



def draw_image(dps, ticks, check_column_name="zxj"):

    # 提取时间和价格
    times = [mdates.date2num(data['time']) for data in ticks]
    values = [data[check_column_name] for data in ticks]

    fig, axs = plt.subplots(len(dps), 1, figsize=(10, 15))

    for i, dp in enumerate(dps):
        axs[i].plot_date(times, values, fmt='-', label=check_column_name)
        extreme_times = [mdates.date2num(point['time'])
                         for point in dp.extreme_points]
        extreme_values = [point[check_column_name] for point in dp.extreme_points]
        axs[i].scatter(extreme_times, extreme_values,
                       color='blue', label='Extreme Points')
        candidate_times = [mdates.date2num(
            point['time']) for point in dp.candidate_points]
        candidate_values = [point[check_column_name] for point in dp.candidate_points]
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
    ticks = ticks_helper.get_ticks("2022-09-01", "2022-11-01", "rb", span_type)
    check_column_name = "ccl"
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    # 创建一个DataProcessor实例
    dps = [DataProcessor(2, 15, check_column_name = check_column_name), DataProcessor(
        2, 20, check_column_name=check_column_name), DataProcessor(3, 20, check_column_name=check_column_name), DataProcessor(3, 30, check_column_name=check_column_name)]

    # 处理测试数据
    for data in ticks:
        for dp in dps:
            dp.process_new_data(data)

    for dp in dps:
        dp.print_extreme_points()
    
    # draw_image(dps, ticks, check_column_name)
    # draw_abnormal(ad)
