import random
from collections import deque
from datetime import datetime, timedelta
import matplotlib.pyplot as plt
import mplcursors
import matplotlib.dates as mdates
import heapq
from helper import constance, utils, date_utils, analysis_helper, ticks_helper
import pytz
import numpy as np


class DataProcessor:
    def __init__(self, past_x_hour = 1, next_x_min=3, extreme_point_threshold=0.02, check_column_name="zxj", x_days = 10):
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
        self.x_days = x_days
        self.daily_max_values = {}
        self.daily_min_values = {}
    
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
        # Assuming tick has a 'date' field in 'YYYY-MM-DD' format
        date_str = tick['date']
        current_value = tick[self.check_column_name]

        # Update daily max and min values
        self.daily_max_values[date_str] = max(
            self.daily_max_values.get(date_str, float('-inf')),
            current_value
        )

        self.daily_min_values[date_str] = min(
            self.daily_min_values.get(date_str, float('inf')),
            current_value
        )

        # Parse time
        if type(tick['time']) == str:
            tick['time'] = datetime.strptime(
                tick['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)
        # print(f"{type(data['time'])}")
        
        n = len(self.data)
        if n < self.past_x_hours_num+self.next_x_min_num:  # We don't have enough data for a 2-hour window and additional 3 minutes
            return
        self.update_extreme_points(n)

    def is_absolute_high(self, tick):
        if len(self.daily_max_values) < self.x_days:
            return False

        date_str = tick['date']
        delta = (self.daily_max_values[date_str] -
                 self.daily_min_values[date_str]) * 0.05
        return tick[self.check_column_name] >= self.daily_max_values[date_str] - delta
    
    def is_relative_high(self, tick):
        if len(self.daily_max_values) < self.x_days:
            return False

        date_str = tick['date']
        current_date = datetime.strptime(date_str, '%Y-%m-%d')

        # Get past 10 days of min data
        date_range = [(current_date - timedelta(days=i)
                       ).strftime('%Y-%m-%d') for i in range(1, 14)]
        past_data = [self.daily_min_values[date]
                     for date in date_range if date in self.daily_max_values]

        if not past_data:
            return False

        # Calculate mean and standard deviation of the past 10 days
        mean_value = np.mean(past_data)
        stdev_value = np.std(past_data)

        threshold = mean_value + 1 * stdev_value

        return tick[self.check_column_name] >= threshold

    def is_relative_low(self, tick):
        if len(self.daily_min_values) < self.x_days:
            return False
        
        date_str = tick['date']
        current_date = datetime.strptime(date_str, '%Y-%m-%d')

        # Get past 10 days of min data
        date_range = [(current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(1, 14)]
        past_data = [self.daily_min_values[date]
                     for date in date_range if date in self.daily_min_values]

        if not past_data:
            return False

        # Calculate mean and standard deviation of the past 10 days
        mean_value = np.mean(past_data)
        stdev_value = np.std(past_data)

        threshold = mean_value - 0.4 * stdev_value

        return tick[self.check_column_name] <= threshold
    
    def calculate_correlation(self, n, hours=10):
        """ 
        为当前数据点计算窗口内的相关性 
        hours：我们应该查看之前多少个小时的数据点
        """
        window_size = int(hours * 3600 / 5)
        subset = self.data[n-window_size:n]

        zxj_values = [tick['zxj'] for tick in subset]
        ccl_values = [tick['ccl'] for tick in subset]

        correlation = np.corrcoef(zxj_values, ccl_values)[0, 1]

        return correlation

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

        

        # Absolute high or relative low check
        is_candidate = False
        if self.is_relative_high(check_point) and check_point[self.check_column_name] == max_value_point[self.check_column_name]:
                check_point['extreme_type'] = 'max'
                self.candidate_points.append(check_point)
                is_candidate = True
        elif self.is_relative_low(check_point) and check_point[self.check_column_name] == min_value_point[self.check_column_name]:
                check_point['extreme_type'] = 'min'
                self.candidate_points.append(check_point)
                is_candidate = True
        
        if is_candidate:
            correlation = self.calculate_correlation(n)
            if correlation >= 0.6:
                if check_point['extreme_type'] == 'max':
                    check_point['next_direct'] = 'down'
                elif check_point['extreme_type'] == 'min':
                    check_point['next_direct'] = 'up'
            else:
                if check_point['extreme_type'] == 'max':
                    check_point['next_direct'] = 'up'
                elif check_point['extreme_type'] == 'min':
                    check_point['next_direct'] = 'down'
                
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
    times = [data['time'].strftime('%Y-%m-%d %H:%M:%S') for data in ticks]
    values = [data[check_column_name] for data in ticks]
    zxj_values = [data['zxj'] for data in ticks]

    fig, axs = plt.subplots(
        len(dps) + 1, 1, figsize=(10, 15))

    # 绘制zxj的子图
    zxj_plot, = axs[0].plot(times, zxj_values, color='purple', label='zxj')
    axs[0].set_title('zxj data')
    axs[0].xaxis.set_major_locator(plt.MaxNLocator(10))
    axs[0].tick_params(axis='x', which='both', bottom=False,
                       top=False, labelbottom=False)

    # cursor0 = mplcursors.cursor(zxj_plot, hover=True)
    # cursor0.connect("add", lambda sel: sel.annotation.set_text(
    #     f'Date: {times[sel.target.index]}, Value: {sel.target[1]}'))

    for i, dp in enumerate(dps, start=1):
        ccl_plot, = axs[i].plot(times, values, label=check_column_name)

        extreme_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.extreme_points]
        extreme_values = [point[check_column_name]
                          for point in dp.extreme_points]
        axs[i].scatter(extreme_times, extreme_values,
                       color='blue', label='Extreme Points')

        candidate_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.candidate_points]
        candidate_values = [point[check_column_name]
                            for point in dp.candidate_points]
        axs[i].scatter(candidate_times, candidate_values,
                       color='green', label='Candidate Points')

        error_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.error_points]
        error_values = [point[check_column_name] for point in dp.error_points]
        axs[i].scatter(error_times, error_values,
                       color='red', label='Error Points')

        axs[i].set_title(f'{dp.past_x_hours} hours range - {dp.next_x_min} mins check - right rate: {round(len(dp.extreme_points) * 100 / (len(dp.extreme_points) + len(dp.error_points)), 2)}%, extreme num: {len(dp.extreme_points)}')
        axs[i].xaxis.set_major_locator(plt.MaxNLocator(10))
        axs[i].tick_params(axis='x', which='both', bottom=False,
                           top=False, labelbottom=False)

        # cursor = mplcursors.cursor(ccl_plot, hover=True)
        # cursor.connect("add", lambda sel: sel.annotation.set_text(
        #     f'Date: {times[int(sel.index)]}, Value: {sel.target[1]}'))

    def on_move(event):
        # 如果事件发生在子图之外，则不做任何操作
        if event.inaxes is None:
            return
        # 获取当前鼠标的x坐标1
        x = event.xdata
        # 在每个子图上绘制一条垂直线
        for ax in axs:
            # 清除当前子图上的所有垂直线
            [line.remove() for line in ax.lines if line.get_gid() == 'cursor_line']
            ax.axvline(x=x, color='gray', linestyle='--', gid='cursor_line')
        
        plt.draw()

    fig.canvas.mpl_connect('motion_notify_event', on_move)
    plt.tight_layout()
    plt.show()




if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-05-01", "2022-08-01", "rb", span_type)
    check_column_name = "ccl"
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    # 创建一个DataProcessor实例
    # dps = [DataProcessor(
    #     2, 20, check_column_name=check_column_name), DataProcessor(3, 20, check_column_name=check_column_name), DataProcessor(3, 30, check_column_name=check_column_name)]
    
    dps = [DataProcessor(3, 30, check_column_name=check_column_name)]

    # 处理测试数据
    for data in ticks:
        for dp in dps:
            dp.process_new_data(data)

    for dp in dps:
        dp.print_extreme_points()
    
    draw_image(dps, ticks, check_column_name)
