import random
from collections import deque
from datetime import datetime, timedelta, time
import matplotlib.pyplot as plt
import mplcursors
import matplotlib.dates as mdates
import heapq
from helper import constance, utils, date_utils, analysis_helper, ticks_helper
import pytz
import numpy as np
from scipy.stats import linregress
import math
import copy


class DataProcessor:
    def __init__(self, past_x_hour = 1, next_x_min=3, extreme_point_threshold=0.02, check_column_name="zxj", cut_hour = 3, min_slope_value = 350, accept_slope_value = 600):
        self.data = []
        self.candidate_points = []        
        self.extreme_points = []        
        self.error_points = []
        self.filtered_candidate_points = []
        self.filtered_extreme_points = []
        self.filtered_error_points = []
        self.past_x_hours = past_x_hour
        self.past_x_hours_num = int(past_x_hour * 3600 / 5)
        self.next_x_min = next_x_min
        self.next_x_min_num = int(next_x_min * 60 / 5)
        self.extreme_point_threshold = extreme_point_threshold
        self.check_column_name = check_column_name
        self.records = []
        self.cut_hour = cut_hour
        self.cut_x_hours_num = int(cut_hour * 3600 / 5)
        self.min_slope_value = min_slope_value
        self.accept_slope_value = accept_slope_value

        
    
    def print_extreme_points(self):
        for extreme_point in self.extreme_points:
            utils.log(
                f'{self.past_x_hours}-{self.next_x_min}: Correct {extreme_point["code"]} {extreme_point["time"]} {extreme_point["extreme_type"]} {extreme_point["next_direction"]} {extreme_point["correlation"]} {extreme_point["zxj"]} {extreme_point[self.check_column_name]}')
            

    def print_error_points(self):        
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
        tick['index'] = len(self.data) - 1

        # Parse time
        if type(tick['time']) == str:
            tick['time'] = datetime.strptime(
                tick['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)
        # print(f"{type(data['time'])}")
        
        n = len(self.data)
        if n < self.past_x_hours_num+self.next_x_min_num:  # We don't have enough data for a 2-hour window and additional 3 minutes
            return
        self.update_extreme_points(n)
   
    # 改为找上一个extrem和自己不一样的peak类型的相关性
    def calculate_correlation_by_extreme(self, check_point):
        for i in range(len(self.extreme_points)-1, 0, -1):
            extreme_point = self.extreme_points[i]
            if extreme_point['extreme_type'] != check_point['extreme_type']:
                subset = self.data[extreme_point['index']:check_point['index']]

                zxj_values = [tick['zxj'] for tick in subset]
                ccl_values = [tick['ccl'] for tick in subset]

                correlation = np.corrcoef(zxj_values, ccl_values)[0, 1]

                return correlation
        
        return 0

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

    def linear_regression(self, start_index, end_index, column_name, unit = 1):
        # 假设你有一个价格的时间序列数据，存储在名为prices的列表或数组中
        values = [data[column_name]
                  for data in self.data[start_index:end_index]]
        # 为时间序列数据创建一个时间索引
        time_index = np.arange(len(values))

        # 使用scipy进行线性回归
        slope, intercept, r_value, p_value, std_err = linregress(time_index, values)

        return round(slope * unit, 2)
    
    # TODO 增加斜率判断
    def update_extreme_points(self, n):
        check_point = self.data[n-self.next_x_min_num]
        check_point['index'] = n-self.next_x_min_num
        last_x_hours_and_next_y_min_data = self.data[n-self.past_x_hours_num-self.next_x_min_num:n]       
        
            
        max_value_point = max(
            last_x_hours_and_next_y_min_data, key=lambda x: x[self.check_column_name])
        min_value_point = min(
            last_x_hours_and_next_y_min_data, key=lambda x: x[self.check_column_name])        

        # Absolute high or relative low check
        is_candidate = False
        if check_point[self.check_column_name] == max_value_point[self.check_column_name]:
                check_point['extreme_type'] = 'max'
                check_point['detect_time'] = self.data[-1]['time']
                check_point['detect_zxj'] = self.data[-1]['zxj']
                check_point['detect_index'] = n
                self.candidate_points.append(check_point)
                is_candidate = True
        elif check_point[self.check_column_name] == min_value_point[self.check_column_name]:
                check_point['extreme_type'] = 'min'
                check_point['detect_time'] = self.data[-1]['time']
                check_point['detect_zxj'] = self.data[-1]['zxj']
                check_point['detect_index'] = n
                self.candidate_points.append(check_point)
                is_candidate = True
        
        if is_candidate:
            # Filter 1, far way from last extreme point, need to fix the continuous same direction extreme point issue
            # if self.extreme_points:
            #     last_extreme_value = self.extreme_points[-1][self.check_column_name]
            #     last_extreme_type = self.extreme_points[-1]['extreme_type']
            #     if (last_extreme_type == "max" and (last_extreme_value - check_point[self.check_column_name]) / last_extreme_value < self.extreme_point_threshold) \
            #       or (last_extreme_type == "min" and (check_point[self.check_column_name] - last_extreme_value) / last_extreme_value < self.extreme_point_threshold) :
            #         return  # The value difference is less than 2%, ignore this point
            # Filter 2, add relative check
            # if check_point['extreme_type'] == 'max' and self.is_relative_high(check_point):
            #     self.filtered_candidate_points.append(check_point)
            # elif check_point['extreme_type'] == 'min' and self.is_relative_low(check_point):
            #     self.filtered_candidate_points.append(check_point)
            
            # Filter 3, add trend rate check
            if self.filter_by_slope(check_point):
                self.filtered_candidate_points.append(check_point)

            # Collect extra information
            # 1. Add correlation value
            # correlation = self.calculate_correlation_by_extreme(check_point)
            correlation = self.calculate_correlation(n, 10)
            check_point['correlation'] = round(correlation,2)
            if correlation >= 0.6:
                if check_point['extreme_type'] == 'max':
                    check_point['next_direction'] = 'down'
                elif check_point['extreme_type'] == 'min':
                    check_point['next_direction'] = 'up'
            elif correlation <= -0.6:
                if check_point['extreme_type'] == 'max':
                    check_point['next_direction'] = 'up'
                elif check_point['extreme_type'] == 'min':
                    check_point['next_direction'] = 'down'
            else:
                check_point['next_direction'] = 'unknown'

            # 2. Add slope
            before_slope = self.slope_angle(self.data[check_point['index'] - self.next_x_min_num], check_point)
            check_point['before_slope'] = round(before_slope, 2)
            after_slope = self.slope_angle(check_point, self.data[check_point['index'] + self.next_x_min_num - 1])
            check_point['after_slope'] = round(after_slope, 2)

            # 3. Add linear regression
            check_point['lr_zxj'] = self.linear_regression(n - self.next_x_min_num, n, "zxj", 100)
            check_point['lr_ccl'] = self.linear_regression(n - self.next_x_min_num, n, "ccl")

            # add record information
            self.records.append(check_point)
                
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
                    candidate['extreme'] = True
                    if candidate in self.filtered_candidate_points:
                        self.filtered_candidate_points.remove(candidate)
                        self.filtered_extreme_points.append(candidate)
                        candidate['filtered_extreme'] = True
                else:
                    self.error_points.append(candidate)
                    if candidate in self.filtered_candidate_points:
                        self.filtered_candidate_points.remove(candidate)
                        self.filtered_error_points.append(candidate)

    def slope_angle(self, start, end):
        """
        Given two data points, compute the slope and angle in degrees.
        """
        delta_y = end[self.check_column_name] - start[self.check_column_name]
        delta_x = (end['index'] - start['index']) * 5 / \
            60  # Convert index difference to hours
        slope = delta_y / delta_x
        return slope

    def filter_by_slope(self, check_point):
        """
        Use slope and angle as criteria to filter out data points.
        """
        n = check_point['index']

        # Getting data points for 30 mins before and after the check_point
        before_point = self.data[n - int(30 * 60 / 5)]
        after_point = self.data[min(n + int(30 * 60 / 5), len(self.data) - 1)]

        # Calculating slope and angle for both points
        before_slope = self.slope_angle(before_point, check_point)
        after_slope = self.slope_angle(check_point, after_point)

        # Checking the conditions, 350 is only for RB, need to check for other contracts
        if (abs(after_slope) > abs(before_slope) and abs(after_slope) >= self.min_slope_value) or abs(after_slope) >= self.accept_slope_value:
            return True
        return False
    
    def print_metrics(self):
        prefix = f"{self.past_x_hours}_{self.next_x_min}_{self.cut_hour}"
        results = []
        for i in range(0, len(self.records)):
            data = self.records[i]
            result, max_value, min_value, max_win, max_loss = 0, 0, 0, 0, 0
            is_overlap = False
            trade_time = "9999"
            if len(self.data) > data['index'] + self.cut_x_hours_num:
                future_data = self.data[data['index'] + self.cut_x_hours_num]
                future_zxj = future_data["zxj"]
                trade_time = future_data['time'].strftime('%Y-%m-%d_%H:%M:%S')
                j = i+1
                if 'filtered_extreme' in data:
                    while j < len(self.records):
                        if 'filtered_extreme' in self.records[j]:
                            is_overlap = future_data['index'] > self.records[j]['index']
                            break
                        j+=1
                result = 0
                sub_datas = self.data[data['index'] +
                                    1:data['index'] + self.cut_x_hours_num + 1]
                max_value = max(data['zxj'] for data in sub_datas)
                min_value = min(data['zxj'] for data in sub_datas)
                if future_zxj != 0:            
                    if data['next_direction'] == "up" or data['lr_zxj'] > 5:
                        result = future_zxj - data['detect_zxj']
                        max_win = max_value - data['detect_zxj']
                        max_loss = min_value - data['detect_zxj']
                    elif data['next_direction'] == "down" or data['lr_zxj'] < -5:
                        result = data['detect_zxj'] - future_zxj
                        max_win = data['detect_zxj'] - min_value
                        max_loss = data['detect_zxj'] - max_value
                 
            # utils.log(
            #     f"{data['code']} {data['time']} {data['extreme_type']} {'filtered_extreme' in data} {data['zxj']} {data['detect_zxj']} {future_zxj} {result} {max_win} {max_loss} {data['before_slope']} {data['after_slope']} {data['correlation']} {data['lr_zxj']} {data['lr_ccl']}")
            
            results.append({
                "prefix": prefix,
                "code": data['code'],
                "date": data['time'].strftime('%Y-%m-%d'),
                "time": data['time'].strftime('%H:%M:%S'),
                "detect_time": data['detect_time'].strftime('%H:%M:%S'),
                "trade_time": trade_time,
                "extreme_type": data['extreme_type'],
                "filtered_extreme": 'filtered_extreme' in data,
                "is_overlap": is_overlap,
                "zxj": data['zxj'],
                "detect_zxj": data['detect_zxj'],
                "future_zxj": future_zxj,
                "result": result,
                "max_win": max_win,
                "max_loss": max_loss,
                "before_slope": data['before_slope'],
                "after_slope": data['after_slope'],
                "correlation": data['correlation'],
                "lr_zxj": data['lr_zxj'],
                "lr_ccl": data['lr_ccl']
            })
            
                # f"{prefix} {data['code']} {data['time'].strftime('%Y-%m-%d %H:%M:%S')} {data['detect_time'].strftime('%H:%M:%S')} {trade_time} {data['extreme_type']} {'filtered_extreme' in data} {is_overlap} {data['zxj']} {data['detect_zxj']} {future_zxj} {result} {max_win} {max_loss} {data['before_slope']} {data['after_slope']} {data['correlation']} {data['lr_zxj']} {data['lr_ccl']}")
        result_win = sum([result['result'] for result in results])
        result_true_win = sum([result['result'] for result in results if result['filtered_extreme']])
        statistic = {
            "prefix": prefix,
            "all_count": len(results),
            "filtered_count": len(self.filtered_extreme_points) + len(self.filtered_error_points),
            "correct_count": len(self.filtered_extreme_points),
            "correct_rate": round(len(self.filtered_extreme_points) * 100 / (len(self.filtered_extreme_points) + len(self.filtered_error_points)), 2),
            "result_win": round(result_win, 2),
            "result_avg": round(result_win / len(results), 2),
            "true_result_win": round(result_true_win, 2),
            "true_result_avg": round(result_true_win / len([result for result in results if result['filtered_extreme']]), 2),
            "over_lap_count": len([result for result in results if result['is_overlap']]),
            "over_lag_rate": round(len([result for result in results if result['is_overlap']]) * 100 / len([result for result in results if result['filtered_extreme']]), 2)
        }
        utils.log(
            f"{prefix} all count {len(results)} correct {len(self.filtered_extreme_points)}, rate: {round(len(self.filtered_extreme_points) * 100 / (len(self.filtered_extreme_points) + len(self.filtered_error_points)), 2)}%, result: {round(result_win, 2)}, avg: {round(result_win / len(results), 2)} true result: {round(result_true_win, 2)} true avg: {round(result_true_win / len([result['result'] for result in results if result['filtered_extreme']]), 2)} over lap: {len([result for result in results if result['is_overlap']])}")
            
        return results, statistic

    # 1. 缓慢持续下跌趋势找波峰，缓慢持续上涨趋势找波谷，调整区间两头都要找
    # 2. 收盘时，必然会出现持仓量下跌，从而引起价格变化，可以不予理会
    # 3. 有可能有连续的波峰或波谷，所以超过30分钟之后，发现并没有走远，那么可以考虑观望
    # 4. 实时检测异常情况
    def print_verify_check(self):
        for i in range(0, len(self.data)):
            if 'filtered_extreme' in self.data[i]:
                extreme_point = self.data[i]
                while i < len(self.data)-1:
                    i += 1
                    if "extreme" in self.data[i]:
                        if extreme_point['next_direction'] == "up":
                            result = self.data[i]['detect_zxj'] - extreme_point['detect_zxj']
                        elif extreme_point['next_direction'] == "down":
                            result = extreme_point['detect_zxj'] - self.data[i]['detect_zxj']
                        else:
                            result = 0
                        utils.log(
                            f'{extreme_point["code"]} {extreme_point["time"]} {extreme_point["extreme_type"]} {extreme_point["zxj"]} {extreme_point["detect_zxj"]} {extreme_point["correlation"]} {extreme_point["lr_zxj"]} {extreme_point["next_direction"]} {self.data[i]["zxj"]} {self.data[i]["detect_zxj"]} {result}')
                        i -= 1
                        break

def draw_image(dps, ticks, check_column_name="zxj"):
    # 提取时间和价格
    times = [data['time'].strftime('%Y-%m-%d %H:%M:%S') for data in ticks]
    values = [data[check_column_name] for data in ticks]
    zxj_values = [data['zxj'] for data in ticks]

    fig, axs = plt.subplots(
        2, 1, figsize=(10, 15))

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
        

        filtered_extreme_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.filtered_extreme_points]
        filtered_extreme_values = [point[check_column_name]
                                   for point in dp.filtered_extreme_points]
        axs[i].scatter(filtered_extreme_times, filtered_extreme_values,
                       color='blueviolet', label='Extreme Points')
        
        # for t, v, point in zip(extreme_times, extreme_values, dp.extreme_points):
        #     axs[i].scatter(t, v, color='blue', label='Candidate Points')

        #     # 加入箭头部分的代码
        #     if point['next_direction'] == 'up':
        #         axs[i].arrow(t, v, 0, 0.5, head_width=0.1,
        #                      head_length=0.2, fc='red', ec='red')
        #     elif point['next_direction'] == 'down':
        #         axs[i].arrow(t, v, 0, -0.5, head_width=0.1,
        #                      head_length=0.2, fc='green', ec='green')

        

        candidate_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.candidate_points]
        candidate_values = [point[check_column_name]
                            for point in dp.candidate_points]        
        axs[i].scatter(candidate_times, candidate_values,
                       color='green', label='Candidate Points')
        

        filtered_candidate_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.filtered_candidate_points]
        filtered_candidate_values = [point[check_column_name]
                            for point in dp.filtered_candidate_points]
        axs[i].scatter(filtered_candidate_times, filtered_candidate_values,
                       color='lime', label='Candidate Points')
        
        # for t, v, point in zip(candidate_times, candidate_values, dp.candidate_points):
        #     axs[i].scatter(t, v, color='green', label='Candidate Points')

        #     # 加入箭头部分的代码
        #     if point['next_direction'] == 'up':
        #         axs[i].arrow(t, v, 0, 0.5, head_width=0.1,
        #                      head_length=0.2, fc='red', ec='red')
        #     elif point['next_direction'] == 'down':
        #         axs[i].arrow(t, v, 0, -0.5, head_width=0.1,
        #                      head_length=0.2, fc='green', ec='green')
                

        error_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.error_points]
        error_values = [point[check_column_name] for point in dp.error_points]
        axs[i].scatter(error_times, error_values,
                       color='red', label='Error Points')

        filtered_error_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.filtered_error_points]
        filtered_error_values = [point[check_column_name]
                        for point in dp.filtered_error_points]
        axs[i].scatter(filtered_error_times, filtered_error_values,
                       color='black', label='Error Points')

        axs[i].set_title(f'{dp.past_x_hours} hours range - {dp.next_x_min} mins check - right rate: {round(len(dp.filtered_extreme_points) * 100 / (len(dp.filtered_extreme_points) + len(dp.filtered_error_points)), 2)}%, extreme num: {len(dp.filtered_extreme_points)}')
        axs[i].xaxis.set_major_locator(plt.MaxNLocator(10))
        axs[i].tick_params(axis='x', which='both', bottom=False,
                           top=False, labelbottom=False)

        # cursor = mplcursors.cursor(ccl_plot, hover=True)
        # cursor.connect("add", lambda sel: sel.annotation.set_text(
        #     f'Date: {times[int(sel.index)]}, Value: {sel.target[1]}'))
        break

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


def prepare_dps(check_column_name="ccl"):
    dps = []
    for past_x_hour in [3, 6]:
        for cut_hour in [3, 6, 8]:
            for next_x_min in [10, 30]:
                if next_x_min == 30:
                    min_slope_value = 350
                    accept_slope_value = 600
                elif next_x_min == 20:
                    min_slope_value = 380
                    accept_slope_value = 650
                elif next_x_min == 15:
                    min_slope_value = 450
                    accept_slope_value = 750
                elif next_x_min == 10:
                    min_slope_value = 500
                    accept_slope_value = 800
                # for min_slope_value in [, 1, 2]:
                #     for accept_slope_value in [0.5, 1, 2]:
                dps.append(DataProcessor(past_x_hour, next_x_min, check_column_name=check_column_name,
                                         cut_hour=cut_hour, min_slope_value=min_slope_value, accept_slope_value=accept_slope_value))
    return dps


def prepare_dps_simple(check_column_name="ccl"):
    dps = []
    dps.append(DataProcessor(past_x_hour = 6, next_x_min = 30, check_column_name=check_column_name,
                                     cut_hour=6, min_slope_value=350, accept_slope_value=600))
    return dps


def process_data(dps, start_date, end_date, contract_type="rb", verify_name="verify", is_draw_image=False, check_column_name="ccl"):
    span_type = "5sec"
    
    final_results = []
    statistics = []
    for dp in dps:
        ticks = ticks_helper.get_ticks(
            start_date, end_date, contract_type, span_type)
        # utils.log("get {} ticks".format(len(ticks)))
        for data in ticks:
            dp.process_new_data(data)

        result, statistic = dp.print_metrics()
        final_results.extend(result)
        statistics.append(statistic)

    utils.echo_dics(statistics)
    utils.convert_dic_to_csv(f"{verify_name}", final_results)
    utils.convert_dic_to_csv(f"{verify_name}_statistic", statistics)
    if is_draw_image:
        draw_image(dps, ticks, check_column_name=check_column_name)

if __name__ == "__main__":    
    # process_data("2022-05-01", "2022-08-01")
    check_column_name = "ccl"
    
    # 处理测试数据
    # round 1
    # dps = prepare_dps(check_column_name)
    # process_data(dps, "2022-04-20", "2022-08-01",verify_name="verify_05_08", check_column_name=check_column_name)

    # round 2
    dps = prepare_dps_simple(check_column_name)
    process_data(dps, "2022-09-01", "2022-11-20", verify_name="verify_09_12", check_column_name=check_column_name, is_draw_image=True)
    # round 3
    # dps = prepare_dps(check_column_name)
    # process_data(dps, "2021-12-01", "2022-03-10", verify_name="verify_12_03", check_column_name=check_column_name)

    # draw_image(dps, ticks, check_column_name)
