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

# contract status => [available,extremDetected, holding]
# mark result => [precheck pass, precheck fail, observe pass, observe fail]
# Observed
# prechecked


class DataProcessor:
    def __init__(self, past_x_hour=1, precheck_x_min=3, candidate_x_min=3, check_column_name="zxj", cut_hour=3, precheck_min_slope_value=350, precheck_accept_slope_value=600):
        self.data = []
        self.past_x_hours = past_x_hour
        self.past_x_hours_num = int(past_x_hour * 3600 / 5)
        self.candidate_points = []
        self.candidate_x_min = candidate_x_min
        self.candidate_x_min_num = int(candidate_x_min * 60 / 5)
        self.extreme_points = []
        self.error_points = []
        # Two reasons, one is not pass current check point, anothere is there is no check point before pass the check
        self.change_back_points = []
        self.precheck_candidate_points = []
        self.precheck_x_min = precheck_x_min
        self.precheck_x_min_num = int(precheck_x_min * 60 / 5)
        self.precheck_min_slope_value = precheck_min_slope_value
        self.precheck_accept_slope_value = precheck_accept_slope_value
        self.observe_passed_points = []
        self.check_column_name = check_column_name
        self.records = []
        self.cut_hour = cut_hour
        self.cut_x_hours_num = int(cut_hour * 3600 / 5)
        self.new_check_point = False
        self.last_valid_check_point = {}
        self.check_points = []
        self.check_point = {}
        self.trade_list = []

    def process_new_data(self, tick):
        self.data.append(tick)
        tick['index'] = len(self.data) - 1

        # Parse time
        if type(tick['time']) == str:
            tick['time'] = datetime.strptime(
                tick['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)

        n = len(self.data)
        # We don't have enough data for a 2-hour window and additional 3 minutes
        if n < self.past_x_hours_num+self.precheck_x_min_num:
            return

        self.start_process(n)

    # 改为找上一个extrem和自己不一样的peak类型的相关性
    def calculate_correlation_by_extreme(self):
        for i in range(len(self.extreme_points)-1, 0, -1):
            extreme_point = self.extreme_points[i]
            if extreme_point['extreme_type'] != self.check_point['extreme_type']:
                subset = self.data[extreme_point['index']:self.check_point['index']]

                zxj_values = [tick['zxj'] for tick in subset]
                ccl_values = [tick['ccl'] for tick in subset]

                correlation = np.corrcoef(zxj_values, ccl_values)[0, 1]

                return correlation

        return 0

    def calculate_correlation(self, hours=10):
        window_size = int(hours * 3600 / 5)
        subset = self.data[-window_size:]
        zxj_values = [tick['zxj'] for tick in subset]
        ccl_values = [tick['ccl'] for tick in subset]
        correlation = np.corrcoef(zxj_values, ccl_values)[0, 1]
        return round(correlation, 2)

    def linear_regression(self, start_index, end_index, column_name, unit=1):
        values = [data[column_name] for data in self.data[start_index:end_index]]
        time_index = np.arange(len(values))
        slope, intercept, r_value, p_value, std_err = linregress(
            time_index, values)

        return round(slope * unit, 2)

    def set_last_to_current_extrem_slope(self):
        last_peak_index = 0
        for last_passed_point in self.observe_passed_points[::-1]:
            if last_passed_point['extreme_type'] != self.check_point['extreme_type']:
                last_peak_index = last_passed_point['index']
                break
        
        if last_peak_index == 0:
            for last_extreme_point in self.extreme_points[::-1]:
                if last_extreme_point['extreme_type'] != self.check_point['extreme_type']:
                    last_peak_index = last_extreme_point['index']
                    break
        
        if last_peak_index == 0:
            self.check_point['last_to_current_slope'] = 9999999999
            return
        
        self.check_point['last_to_current_slope'] =  round(self.slope_angle(self.data[last_peak_index], self.check_point), 2)

    def add_candidate_information(self):
        # Collect extra information
        # 1. Add correlation value
        # 2. Initial mark result
        # 3. Initial observe threshold, two conditions, one is the next 1/3 time slope >= before whole slope , the other is the value exceeed 30%~50% x time
        correlation = self.calculate_correlation(10)
        self.check_point['correlation'] = correlation
        self.check_point['next_direction'] = 'unknown'
        self.check_point['mark_result'] = "unknown"
        self.set_last_to_current_extrem_slope()


        # 查看上一个
            # 如果是不同向observ pass不重要，修改observe通过条件为上一个的不通过条件即可，且还要看上一个同向是否为observe pass
            # 如果不是，那么依旧要对上一个做observe的判断？
            # 如果是同向
            #   如果上一个是observe pass，那么当前也是observe pass
            #   如果上一个是observe fail，那么找到上一个非同向的        
        past_x_hours_data = self.data[self.check_point['index'] - self.past_x_hours_num:self.check_point['index']]
        if self.check_point['extreme_type'] == 'max':
            # Add next direction
            if correlation >= 0.6:            
                self.check_point['next_direction'] = 'down'
            elif correlation <= -0.6:
                self.check_point['next_direction'] = 'up'            
            # Add observe threshold a - (a-b) * 0.33
            self.check_point['observe_ccl_threshold'] = int(self.check_point[self.check_column_name] - (self.check_point[self.check_column_name] - min([data[self.check_column_name] for data in past_x_hours_data])) * 0.33)           
        elif self.check_point['extreme_type'] == 'min':
            if correlation >= 0.6:                        
                self.check_point['next_direction'] = 'up'
            elif correlation <= -0.6:
                self.check_point['next_direction'] = 'down'
            # Add observe threshold a + (b-a) * 0.33
            self.check_point['observe_ccl_threshold'] = int(self.check_point[self.check_column_name] + (max([data[self.check_column_name] for data in past_x_hours_data]) - self.check_point[self.check_column_name]) * 0.33)
                
    def process_precheck(self, n):
        # analysis, add trend rate check
        past_num = n - self.check_point['index'] - 1
        if past_num >= self.precheck_x_min_num:
            if self.check_by_slope(self.precheck_x_min_num, True):
                self.check_point['mark_result'] = "precheck_pass"

        # Pre
        
        if  past_num >= int(self.past_x_hours_num / 3):
            current_slope = round(self.slope_angle(self.check_point, self.data[n-1]), 2)
            if abs(current_slope) >= abs(self.check_point['last_to_current_slope']):
                self.check_point['mark_result'] = "precheck_pass"

    # 1. Need to record pass or fail time
    # 2. It is the final result, if not pass, need to change back check point
    def process_observe(self, n):
        current_data = self.data[n-1]
        if self.check_point['extreme_type'] == 'max':
            if  current_data[self.check_column_name] > self.check_point[self.check_column_name]:
                self.check_point['mark_result'] = "observe_fail"
            elif current_data[self.check_column_name] < self.check_point['observe_ccl_threshold']:
                self.check_point['mark_result'] = "observe_pass"
        elif self.check_point['extreme_type'] == 'min':
            if current_data[self.check_column_name] < self.check_point[self.check_column_name]:
                self.check_point['mark_result'] = "observe_fail"
            elif current_data[self.check_column_name] > self.check_point['observe_ccl_threshold']:
                self.check_point['mark_result'] = "observe_pass"
        

    def start_analyse(self, n):
        if self.new_check_point:
            # 1. Check do we need to give up previous observed extreme point
            if self.last_valid_check_point["mark_result"] != "observe_pass":            
                a = 1
            # 2. Add some information to the check point
            self.add_candidate_information()           
        
        # It is not the first time, start normal analysis
        if self.check_point["mark_result"] == "observe_fail":
            utils.log("error status!")
            return
        elif self.check_point["mark_result"] != "observe_pass":
            self.process_observe(n)
            # If pass observe
            #   if before is observe pass
            #   if before is observe fail
            #   if before is precheck pass
            if "precheck" not in self.check_point["mark_result"]:
                self.process_precheck(n)
                if self.check_point['mark_result'] == "precheck_pass":
                    self.precheck_candidate_points.append(self.check_point)
                    if self.last_valid_check_point:
                        if self.last_valid_check_point['mark_result'] == "observe_pass":
                            # TODO do the trade
                        elif self.last_valid_check_point['mark_result'] == "precheck_pass":
                            # If last check point status is precheck_pass, which mean the ccl is still between pass or fail, so we need to check the slope
                            # Which means current check point is fake, just keep same with last one.
                            # if last_check_point['extreme_type'] == self.check_point['extreme_type']:                                # TODO do the trade
                            #     self.check_point = last_check_point
                            #     self.check_points.remove(last_check_point)
                    # If pass precheck
                    #   if before is observe pass
                    #   if before is observe fail
                    #   if before is precheck pass
        
    def check_candidate(self, n):
        last_x_hours_and_next_y_min_data = self.data[n - self.past_x_hours_num - self.candidate_x_min_num:n]

        max_value_point = max(last_x_hours_and_next_y_min_data, key=lambda x: x[self.check_column_name])
        min_value_point = min(last_x_hours_and_next_y_min_data, key=lambda x: x[self.check_column_name])

        extreme_type = "max" if self.check_point[self.check_column_name] == max_value_point[self.check_column_name] else ("min" if self.check_point[self.check_column_name] == min_value_point[self.check_column_name] else "")

        if extreme_type != "":
            self.check_points.append(self.check_point)
            self.check_point = self.data[n-self.candidate_x_min_num]
            self.check_point['extreme_type'] = extreme_type
            self.check_point['add_candidate_time'] = self.data[-1]['time']
            self.check_point['add_candidate_zxj'] = self.data[-1]['zxj']
            self.check_point['add_candidate_index'] = n
            self.new_check_point = True
            self.candidate_points.append(self.check_point)
        else:
            self.new_check_point = False

    def record_extreme_point(self, n):
        for candidate in self.candidate_points.copy():
            if candidate['time'] < self.data[-1]['time'] - timedelta(hours=self.past_x_hours):
                self.candidate_points.remove(candidate)
                next_x_hours_data = self.data[n-self.past_x_hours_num:n]
                max_value_point = max(next_x_hours_data, key=lambda x: x[self.check_column_name])
                min_value_point = min(next_x_hours_data, key=lambda x: x[self.check_column_name])

                if (candidate['extreme_type'] == 'max' and candidate[self.check_column_name] >= max_value_point[self.check_column_name]) or \
                   (candidate['extreme_type'] == 'min' and candidate[self.check_column_name] <= min_value_point[self.check_column_name]):
                    self.extreme_points.append(candidate)
                    candidate['extreme'] = True
                    if candidate in self.precheck_candidate_points:
                        self.precheck_candidate_points.remove(candidate)
                        candidate['pre_checked'] = True
                else:
                    self.error_points.append(candidate)
                    if candidate in self.precheck_candidate_points:
                        self.precheck_candidate_points.remove(candidate)

    def start_process(self, data_length):
        self.check_candidate(data_length)

        # Only have more than extreme points, to do the futher analysis
        if len(self.extreme_points) > 1:
            self.start_analyse(data_length)

        # Record the extreme point
        self.record_extreme_point(data_length)

        # add record information
        self.records.append(self.check_point)

    def slope_angle(self, start, end):
        delta_y = end[self.check_column_name] - start[self.check_column_name]
        delta_x = (end['index'] - start['index']) * 5 / 60  # Convert index difference to hours
        slope = delta_y / delta_x
        return slope

    def check_by_slope(self, check_num, is_record_slope=False):
        """
        Use slope and angle as criteria to filter out data points.
        """
        n = self.check_point['index']

        # Getting data points for 30 mins before and after the self.check_point
        before_point = self.data[n - check_num - 1]
        after_point = self.data[min(n + check_num + 1, len(self.data) - 1)]

        # Calculating slope and angle for both points
        before_slope = self.slope_angle(before_point, self.check_point)
        after_slope = self.slope_angle(self.check_point, after_point)

        if is_record_slope:
            self.check_point['before_slope'] = round(before_slope, 2)
            self.check_point['after_slope'] = round(after_slope, 2)

        # Checking the conditions, 350 is only for RB, need to check for other contracts
        if (abs(after_slope) > abs(before_slope) and abs(after_slope) >= self.precheck_min_slope_value) or abs(after_slope) >= self.precheck_accept_slope_value:
            return True
        return False

    def print_metrics(self):
        prefix = f"{self.past_x_hours}_{self.precheck_x_min}_{self.cut_hour}"
        results = []
        for i in range(0, len(self.records)):
            data = self.records[i]
            result, max_value, min_value, max_win, max_loss, future_zxj = 0, 0, 0, 0, 0, 0
            is_overlap = False
            trade_time = "9999"
            if len(self.data) > data['index'] + self.cut_x_hours_num:
                future_data = self.data[data['index'] + self.cut_x_hours_num]
                future_zxj = future_data["zxj"]
                trade_time = future_data['time'].strftime('%Y-%m-%d_%H:%M:%S')
                j = i+1
                if 'precheck_extreme' in data:
                    while j < len(self.records):
                        if 'precheck_extreme' in self.records[j]:
                            is_overlap = future_data['index'] > self.records[j]['index']
                            break
                        j += 1
                result = 0
                sub_datas = self.data[data['index'] +
                                      1:data['index'] + self.cut_x_hours_num + 1]
                max_value = max(data['zxj'] for data in sub_datas)
                min_value = min(data['zxj'] for data in sub_datas)
                if future_zxj != 0:
                    if data['next_direction'] == "up" or data['lr_zxj'] > 5:
                        result = future_zxj - data['add_candidate_zxj']
                        max_win = max_value - data['add_candidate_zxj']
                        max_loss = min_value - data['add_candidate_zxj']
                    elif data['next_direction'] == "down" or data['lr_zxj'] < -5:
                        result = data['add_candidate_zxj'] - future_zxj
                        max_win = data['add_candidate_zxj'] - min_value
                        max_loss = data['add_candidate_zxj'] - max_value

            # utils.log(
            #     f"{data['code']} {data['time']} {data['extreme_type']} {'precheck_extreme' in data} {data['zxj']} {data['add_candidate_zxj']} {future_zxj} {result} {max_win} {max_loss} {data['before_slope']} {data['after_slope']} {data['correlation']} {data['lr_zxj']} {data['lr_ccl']}")

            results.append({
                "prefix": prefix,
                "code": data['code'],
                "date": data['time'].strftime('%Y-%m-%d'),
                "time": data['time'].strftime('%H:%M:%S'),
                "add_candidate_time": data['add_candidate_time'].strftime('%H:%M:%S'),
                "trade_time": trade_time,
                "extreme_type": data['extreme_type'],
                "precheck_extreme": 'precheck_extreme' in data,
                "is_overlap": is_overlap,
                "zxj": data['zxj'],
                "add_candidate_zxj": data['add_candidate_zxj'],
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

            # f"{prefix} {data['code']} {data['time'].strftime('%Y-%m-%d %H:%M:%S')} {data['add_candidate_time'].strftime('%H:%M:%S')} {trade_time} {data['extreme_type']} {'precheck_extreme' in data} {is_overlap} {data['zxj']} {data['add_candidate_zxj']} {future_zxj} {result} {max_win} {max_loss} {data['before_slope']} {data['after_slope']} {data['correlation']} {data['lr_zxj']} {data['lr_ccl']}")
        result_win = sum([result['result'] for result in results])
        result_true_win = sum([result['result']
                               for result in results if result['precheck_extreme']])
        statistic = {
            "prefix": prefix,
            "all_count": len(results),
            "precheck_count": len(self.precheck_candidate_points),
            "result_win": round(result_win, 2),
            "result_avg": round(result_win / len(results), 2),
            "true_result_win": round(result_true_win, 2),
            "true_result_avg": round(result_true_win / len([result for result in results if result['precheck_extreme']]), 2),
            "over_lap_count": len([result for result in results if result['is_overlap']]),
            "over_lag_rate": round(len([result for result in results if result['is_overlap']]) * 100 / len([result for result in results if result['precheck_extreme']]), 2)
        }
        utils.log(
            f"{prefix} all count {len(results)} result: {round(result_win, 2)}, avg: {round(result_win / len(results), 2)} true result: {round(result_true_win, 2)} true avg: {round(result_true_win / len([result['result'] for result in results if result['precheck_extreme']]), 2)} over lap: {len([result for result in results if result['is_overlap']])}")

        return results, statistic

    # 1. 缓慢持续下跌趋势找波峰，缓慢持续上涨趋势找波谷，调整区间两头都要找
    # 2. 收盘时，必然会出现持仓量下跌，从而引起价格变化，可以不予理会
    # 3. 有可能有连续的波峰或波谷，所以超过30分钟之后，发现并没有走远，那么可以考虑观望
    # 4. 实时检测异常情况


def draw_image(dps, ticks, check_column_name="zxj"):
    # 提取时间和价格
    times = [data['time'].strftime('%Y-%m-%d %H:%M:%S') for data in ticks]
    values = [data[check_column_name] for data in ticks]
    zxj_values = [data['zxj'] for data in ticks]

    fig, axs = plt.subplots(2, 1, figsize=(10, 15))

    # 绘制zxj的子图
    zxj_plot, = axs[0].plot(times, zxj_values, color='purple', label='zxj')  # type: ignore
    axs[0].set_title('zxj data')  # type: ignore
    axs[0].xaxis.set_major_locator(plt.MaxNLocator(10))  # type: ignore
    axs[0].tick_params(axis='x', which='both', bottom=False, top=False, labelbottom=False)  # type: ignore

    # cursor0 = mplcursors.cursor(zxj_plot, hover=True)
    # cursor0.connect("add", lambda sel: sel.annotation.set_text(
    #     f'Date: {times[sel.target.index]}, Value: {sel.target[1]}'))

    for i, dp in enumerate(dps, start=1):
        ccl_plot, = axs[i].plot(times, values, label=check_column_name)   # type: ignore

        extreme_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.extreme_points]
        extreme_values = [point[check_column_name]
                          for point in dp.extreme_points]
        axs[i].scatter(extreme_times, extreme_values, color='blue', label='Extreme Points')   # type: ignore

        precheck_extreme_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.precheck_extreme_points]
        precheck_extreme_values = [point[check_column_name]
                                   for point in dp.precheck_extreme_points]
        axs[i].scatter(precheck_extreme_times, precheck_extreme_values,   # type: ignore
                       color='blueviolet', label='Extreme Points')

        candidate_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.candidate_points]
        candidate_values = [point[check_column_name]
                            for point in dp.candidate_points]
        axs[i].scatter(candidate_times, candidate_values,   # type: ignore
                       color='green', label='Candidate Points')

        precheck_candidate_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.precheck_candidate_points]
        precheck_candidate_values = [point[check_column_name]
                                     for point in dp.precheck_candidate_points]
        axs[i].scatter(precheck_candidate_times, precheck_candidate_values, # type: ignore
                       color='lime', label='Candidate Points')

        error_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.error_points]
        error_values = [point[check_column_name] for point in dp.error_points]
        axs[i].scatter(error_times, error_values, # type: ignore
                       color='red', label='Error Points')

        precheck_error_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.precheck_error_points]
        precheck_error_values = [point[check_column_name]
                                 for point in dp.precheck_error_points]
        axs[i].scatter(precheck_error_times, precheck_error_values, # type: ignore
                       color='black', label='Error Points')

        axs[i].set_title(f'{dp.past_x_hours} hours range - {dp.precheck_x_min} mins check - right rate: {round(len(dp.precheck_extreme_points) * 100 / (len(dp.precheck_extreme_points) + len(dp.precheck_error_points)), 2)}%, extreme num: {len(dp.precheck_extreme_points)}') # type: ignore
        axs[i].xaxis.set_major_locator(plt.MaxNLocator(10))  # type: ignore
        axs[i].tick_params(axis='x', which='both', bottom=False, # type: ignore
                           top=False, labelbottom=False)

        break

    def on_move(event):
        # 如果事件发生在子图之外，则不做任何操作
        if event.inaxes is None:
            return
        # 获取当前鼠标的x坐标1
        x = event.xdata
        # 在每个子图上绘制一条垂直线
        for ax in axs: # type: ignore
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
            for precheck_x_min in [10, 30]:
                if precheck_x_min == 30:
                    precheck_min_slope_value = 350
                    precheck_accept_slope_value = 600
                elif precheck_x_min == 20:
                    precheck_min_slope_value = 380
                    precheck_accept_slope_value = 650
                elif precheck_x_min == 15:
                    precheck_min_slope_value = 450
                    precheck_accept_slope_value = 750
                elif precheck_x_min == 10:
                    precheck_min_slope_value = 500
                    precheck_accept_slope_value = 800
                else:
                    precheck_min_slope_value = 350
                    precheck_accept_slope_value = 600
                # for precheck_min_slope_value in [, 1, 2]:
                #     for precheck_accept_slope_value in [0.5, 1, 2]:
                dps.append(DataProcessor(past_x_hour, precheck_x_min, check_column_name=check_column_name,
                                         cut_hour=cut_hour, precheck_min_slope_value=precheck_min_slope_value, precheck_accept_slope_value=precheck_accept_slope_value))
    return dps


def prepare_dps_simple(check_column_name="ccl"):
    dps = []
    dps.append(DataProcessor(past_x_hour=6, precheck_x_min=30, check_column_name=check_column_name,
                             cut_hour=6, precheck_min_slope_value=350, precheck_accept_slope_value=600))
    return dps


def process_data(dps, start_date, end_date, contract_type="rb", verify_name="verify", is_draw_image=False, check_column_name="ccl"):
    span_type = "5sec"

    final_results = []
    statistics = []
    ticks = []
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
    process_data(dps, "2022-09-01", "2022-11-20", verify_name="verify_09_12",
                 check_column_name=check_column_name, is_draw_image=True)
    # round 3
    # dps = prepare_dps(check_column_name)
    # process_data(dps, "2021-12-01", "2022-03-10", verify_name="verify_12_03", check_column_name=check_column_name)

    # draw_image(dps, ticks, check_column_name)
