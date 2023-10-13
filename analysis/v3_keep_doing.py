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
    def __init__(self, cjl_hot_threshold = 1000, cjl_period_min_threshold = 5800, cjl_period_pass_threshold=8000,  cjl_past_num=60, cjl_period_num=3, past_x_hour=3, candidate_x_min=5, precheck_x_min=10, check_column_name="ccl", precheck_min_slope_value=350, precheck_accept_slope_value=600):
        self.data = []
        # cjl abnormal
        self.cjl_period_min_threshold = cjl_period_min_threshold
        self.cjl_period_pass_threshold = cjl_period_pass_threshold
        self.cjl_past_num = cjl_past_num
        self.cjl_period_num = cjl_period_num
        self.cjl_hot_threshold = 1000
        self.must_away_cjl_threshold = 40000


        self.past_x_hours = past_x_hour
        self.past_x_hours_num = int(past_x_hour * 3600 / 5)
        self.check_points = []
        self.candidate_x_min = candidate_x_min
        self.candidate_x_min_num = int(candidate_x_min * 60 / 5)
        self.extreme_points = []
        self.error_points = []
        # Two reasons, one is not pass current check point, anothere is there is no check point before pass the check
        self.change_back_points = []
        self.precheck_check_points = []
        self.precheck_x_min = precheck_x_min
        self.precheck_x_min_num = int(precheck_x_min * 60 / 5)
        self.precheck_min_slope_value = precheck_min_slope_value
        self.precheck_accept_slope_value = precheck_accept_slope_value
        self.observe_passed_points = []
        self.observe_failed_points = []
        self.check_column_name = check_column_name
        self.records = []
        self.new_check_point = False
        self.last_valid_check_point = {}
        self.check_points = []
        self.check_point = {}
        self.trade_list = []

    def process_new_data(self, tick):
        self.data.append(tick)
        tick['index'] = len(self.data) - 1
        if len(self.data) % 10000 == 0:
            utils.log(f"Processed {len(self.data)} ticks")

        # Parse time
        if type(tick['time']) == str:
            tick['time'] = datetime.strptime(
                tick['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)

        n = len(self.data)
        # We don't have enough data for a 2-hour window and additional 3 minutes
        if n < self.past_x_hours_num+self.candidate_x_min_num+1:
            return

        self.start_process(n)

    def calculate_correlation(self, hours=10):
        window_size = int(hours * 3600 / 5)
        subset = self.data[-window_size:]
        zxj_values = [tick['zxj'] for tick in subset]
        ccl_values = [tick['ccl'] for tick in subset]
        correlation = np.corrcoef(zxj_values, ccl_values)[0, 1]
        return round(correlation, 2)
    
    def calculate_correlation_by_index(self, start_index, end_index):
        subset = self.data[start_index:end_index]
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

    def set_next_direction(self):
        correlation = self.calculate_correlation(10)
        self.check_point['correlation'] = correlation
        self.check_point['next_direction'] = 'unknown'
        if self.check_point['extreme_type'] == 'max':
            if correlation >= 0.6:            
                self.check_point['next_direction'] = 'down'
            elif correlation <= -0.6:
                self.check_point['next_direction'] = 'up'
        elif self.check_point['extreme_type'] == 'min':
            if correlation >= 0.6:                        
                self.check_point['next_direction'] = 'up'
            elif correlation <= -0.6:
                self.check_point['next_direction'] = 'down'

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

    #Initial observe threshold, two conditions, one is the next 1/3 time slope >= before whole slope , the other is the value exceeed 30%~50% x time
    def set_observe_pass_threashold(self):
        past_x_hours_data = self.data[self.check_point['index'] - self.past_x_hours_num:self.check_point['index']]
        if self.check_point['extreme_type'] == 'max':
            # Add observe threshold a - (a-b) * 0.33
            self.check_point['observe_ccl_threshold'] = int(self.check_point[self.check_column_name] - (self.check_point[self.check_column_name] - min([data[self.check_column_name] for data in past_x_hours_data])) * 0.33)           
        elif self.check_point['extreme_type'] == 'min':
            # Add observe threshold a + (b-a) * 0.33
            self.check_point['observe_ccl_threshold'] = int(self.check_point[self.check_column_name] + (max([data[self.check_column_name] for data in past_x_hours_data]) - self.check_point[self.check_column_name]) * 0.33)

    def add_candidate_information(self):
        self.set_next_direction()
        self.set_last_to_current_extrem_slope()
        self.set_observe_pass_threashold()
        self.check_point['mark_result'] = "checking"        
                
    def process_precheck(self, n):
        # analysis, add trend rate check
        past_num = n - self.check_point['index'] - 1
        if past_num == self.precheck_x_min_num:
            if self.check_by_slope(self.precheck_x_min_num, True):
                self.check_point['mark_result'] = "precheck_pass"

        # Pre        
        if past_num >= int(self.past_x_hours_num / 3) and past_num < int(self.past_x_hours_num / 2 ):
            current_slope = round(self.slope_angle(self.check_point, self.data[n-1]), 2)
            if abs(current_slope) >= abs(self.check_point['last_to_current_slope']):
                self.check_point['mark_result'] = "precheck_pass"


        if self.check_point["mark_result"] == "precheck_pass":
            self.check_point['precheck_index'] = n-1
            self.precheck_check_points.append(self.check_point)
            # TODO the trade operation for precheck
            self.action_for_precheck_pass()

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
        
        if self.check_point['mark_result'] == "observe_pass":
            self.check_point['observe_check_index'] = n-1
            self.check_point['observe_zxj'] = self.data[-1]['zxj']
            self.observe_passed_points.append(self.check_point)
            self.action_for_observe_pass()
        elif self.check_point['mark_result'] == "observe_fail":
            self.check_point['observe_check_index'] = n-1
            self.observe_failed_points.append(self.check_point)
    
    def action_for_precheck_pass(self): 
        return       
        # if self.last_valid_check_point:
        #     if self.last_valid_check_point['mark_result'] == "observe_pass":
                # TODO do the trade
            # elif self.last_valid_check_point['mark_result'] == "precheck_pass":
                # If last check point status is precheck_pass, which mean the ccl is still between pass or fail, so we need to check the slope
                # Which means current check point is fake, just keep same with last one.
                # if last_check_point['extreme_type'] == self.check_point['extreme_type']:                                # TODO do the trade
                #     self.check_point = last_check_point
                #     self.check_points.remove(last_check_point)
        # If pass precheck
        #   if before is observe pass
        #   if before is observe fail
        #   if before is precheck pass
    
    def action_for_observe_pass(self):
        return
        # If pass observe
            #   if before is observe pass
            #   if before is observe fail
            #   if before is precheck pass

    def trade_analysis(self):
        # 1. check if current after a cjl abnormal
        # 2. must know:
        #   1. Current ccl overall trend, the next possible direction
        #   2. the relation between current ccl and price
        #   3. ccl threshold and cjl abnormal and price direction will be the cut condition
        #   4. consider current trade time, near 23:00 will be a small ccl drop, near 15:00 will be a large ccl drop, this will reflect the in day impact
        # 3. according to the information, make the decision
        # 4. big trend won't lie, but it is posible there is some reverse trend in shot time.
        is_abnomal_end = True
        for i in range(len(self.data)-1, len(self.data)-4, -1):
            if 'anomaly' in self.data[i] and self.data[i]['anomaly'] != "cold":
                is_abnomal_end = False
                break
        
        if not is_abnomal_end:
            return
        
        one_day_span = ticks_helper.get_x_span_number(1, span_type="5sec", unit="d")
        if len(self.data) < one_day_span:
            return 

        past_one_day_data = self.data[len(self.data)-one_day_span]
        ccl_diff = self.data[-1]['ccl'] - past_one_day_data['ccl']
        # 长期ccl趋势
        #   1. 一天前的5min平均数和当前的5min平均数比较，如果当前的5min平均数大，那么长期趋势是上升，反之下降，且差值要超过一个阈值
        #   1. 如果看不出来，就找两天前的以此类推
        # 短期ccl趋势
        #   1. 如果当前ccl是过去1min最大或者最小， 那么短期趋势是上升或者下降
        #   2. 如果看不出来，那么就用过去30sec的平均数和过去3min的平均数比较，如果过去30sec的平均数大，那么短期趋势是上升，反之下降
        # 有两个触发器，一个是成交量异常，止损是下一个异常和当前放向不一样，一个是ccl趋势，止损是ccl趋势改变+上面的止损逻辑



    def start_analyse(self, n):
        last_check_point = self.check_points[-2]
        # 查看上一个
            # 如果是不同向
            #   observ pass不重要，修改observe通过条件为上一个的不通过条件即可，且还要看上一个同向是否为observe pass
            #   如果不是，那么依旧要对上一个做observe的判断？
            # 如果是同向
            #   如果上一个是observe pass，那么当前的是放向加强，顺势，继续不变, 不应该把当前的check point加入到observe pass的列表中
            #   如果上一个是observe fail，那么大概率是强趋势，中间有个调整的check point但是没有发现，可以增加一个cjl的判断用来避免大趋势的错判
            #   如果上一个是其他状态，说明有可能是双头顶或者双底，趋势可以考虑，因为没有observe fail，依旧以上一个为准做判断
        if self.new_check_point:
            # 1. Check do we need to give up previous observed extreme point
            if last_check_point["extreme_type"] == self.check_point["extreme_type"]:            
                # 有可能是双头顶，有可能是前面放向的大趋势，如果要改变方向，必须要有足够的能力来反转
                if last_check_point["mark_result"] == "observe_fail":
                    self.check_point["add_cjl_check"] = True
                else: # (observe_pass, checking or precheck_pass)
                    self.check_point = last_check_point
                    self.check_points.pop()
            else:
                if last_check_point["mark_result"] == "observe_fail":
                    utils.log(f"Cannot image how this happend! {last_check_point['time']} - {self.check_point['time']}")
                elif last_check_point["mark_result"] in ["checking", "precheck_pass"]:
                    self.check_point["observe_ccl_threshold"] = last_check_point["ccl"]            
        
        # Normal analysis
        try:
            if self.check_point["mark_result"] == "observe_fail":
                return
            
            elif self.check_point["mark_result"] != "observe_pass":
                self.process_observe(n)
                if self.check_point["mark_result"] != "observe_pass" and self.check_point["mark_result"] != "precheck_pass":
                    self.process_precheck(n)
        except Exception as e:
            utils.log(f"Exception: {e}")
            utils.log(f"Check point: {self.check_point}")
                
        
    def check_candidate(self, n):
        check_point = self.data[n-self.candidate_x_min_num-1]
        last_x_hours_and_next_y_min_data = self.data[n - self.past_x_hours_num - self.candidate_x_min_num-1:n]

        max_value_point = max(last_x_hours_and_next_y_min_data, key=lambda x: x[self.check_column_name])
        min_value_point = min(last_x_hours_and_next_y_min_data, key=lambda x: x[self.check_column_name])

        extreme_type = "max" if check_point[self.check_column_name] == max_value_point[self.check_column_name] else ("min" if check_point[self.check_column_name] == min_value_point[self.check_column_name] else "")
        self.new_check_point = False
        if extreme_type != "":
            candidate_correlation = self.calculate_correlation_by_index(n-self.candidate_x_min_num, n)
            self.check_point = check_point
            self.check_points.append(self.check_point)
            self.check_point['extreme_type'] = extreme_type
            self.check_point['candidate_correlation'] = candidate_correlation
            self.check_point['add_candidate_time'] = self.data[-1]['time']
            self.check_point['add_candidate_zxj'] = self.data[-1]['zxj']
            self.check_point['add_candidate_index'] = n-1
            self.add_candidate_information()
            self.new_check_point = True                
            self.check_points.append(self.check_point)

    def record_extreme_point(self, n):
        for candidate in (c for c in self.check_points if 'extreme' not in c):            
            if candidate['time'] < self.data[-1]['time'] - timedelta(hours=self.past_x_hours):
                next_x_hours_data = self.data[n-self.past_x_hours_num:n]
                max_value_point = max(next_x_hours_data, key=lambda x: x[self.check_column_name])
                min_value_point = min(next_x_hours_data, key=lambda x: x[self.check_column_name])

                if (candidate['extreme_type'] == 'max' and candidate[self.check_column_name] >= max_value_point[self.check_column_name]) or \
                   (candidate['extreme_type'] == 'min' and candidate[self.check_column_name] <= min_value_point[self.check_column_name]):
                    candidate['extreme'] = True
                    self.extreme_points.append(candidate)
                else:
                    candidate['extreme'] = False
                    self.error_points.append(candidate)

    def check_cjl_abnormal(self):
        if len(self.data) > self.cjl_past_num + self.cjl_period_num:
            past_cjl = [d['cjl'] for d in self.data[-self.cjl_past_num-self.cjl_period_num:-self.cjl_period_num]]
            past_cjl_mean = np.mean(past_cjl)
            past_cjl_std = np.std(past_cjl)
            last_period_cjl_sum = sum([d['cjl'] for d in self.data[-self.cjl_period_num:]])
            last_period_cjl = int(last_period_cjl_sum / self.cjl_period_num)
            if (last_period_cjl - past_cjl_mean > 5 * past_cjl_std and last_period_cjl_sum > self.cjl_period_min_threshold) or last_period_cjl_sum > self.cjl_period_pass_threshold:
                self.data[-1]['anomaly'] = "start"
                # Check past 2 mins slope
                self.data[-1]['past_2_mins_slope'] = round(self.slope_angle(self.data[-24], self.data[-1]), 2)
            else:
                contains_anomaly = False
                for i in range(len(self.data) -1, len(self.data) -4, -1):
                    if 'anomaly' in self.data[i] and self.data[i]['anomaly'] != "cold":
                        contains_anomaly = True
                        break
                if contains_anomaly:
                    if self.data[-1]['cjl'] >= self.cjl_hot_threshold:
                        self.data[-1]['anomaly'] = "hot"
                    elif 'anomaly' in self.data[-2] and 'anomaly' in self.data[-3] and (self.data[-2]['anomaly'] in ["hot", "start"] or self.data[-3]['anomaly'] in ["hot", "start"]):
                        self.data[-1]['anomaly'] = "cold"
                
    def start_process(self, data_length):
        self.check_cjl_abnormal()
        self.check_candidate(data_length)

        # Only have more than extreme points, to do the futher analysis
        # if len(self.extreme_points) > 2:
        #     self.start_analyse(data_length)

        # Record the extreme point
        self.record_extreme_point(data_length)

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

    def verify_check_points(self, n):
        utils.log(f"Verify check points {len(self.check_points)}")
        for i in range(0, len(self.check_points)):
            check_point = self.check_points[i]
            self.percentage_check(check_point, check_point['add_candidate_index'], 1, 'candidate', n)
            self.percentage_check(check_point, check_point['add_candidate_index'], 2, 'candidate', n)
            self.percentage_check(check_point, check_point['add_candidate_index'], 3, 'candidate', n)
            if 'precheck_index' in check_point:
                self.percentage_check(check_point, check_point['precheck_index'], 1, 'precheck', n)
                self.percentage_check(check_point, check_point['precheck_index'], 2, 'precheck', n)
                self.percentage_check(check_point, check_point['precheck_index'], 3, 'precheck', n)
            if 'observe_check_index' in check_point:
                self.percentage_check(check_point, check_point['observe_check_index'], 1, 'observe', n)
                self.percentage_check(check_point, check_point['observe_check_index'], 2, 'observe', n)
                self.percentage_check(check_point, check_point['observe_check_index'], 3, 'observe', n)      

        utils.log(f"Verify observe passed points {len(self.observe_passed_points)}")
        for i in range(0, len(self.observe_passed_points) - 1):
            current_point = self.observe_passed_points[i]
            next_point = self.observe_passed_points[i+1]
            observe_percentage_diff = round((next_point['observe_zxj'] - current_point['observe_zxj']) / current_point['observe_zxj'] * 100, 2)
            current_point['observe_percentage_diff'] = observe_percentage_diff
            if current_point['next_direction'] == 'up':
                if observe_percentage_diff > 0:
                    current_point['win_observe_only'] = 1
                else:
                    current_point['win_observe_only'] = 0
            elif current_point['next_direction'] == 'down':
                if observe_percentage_diff < 0:
                    current_point['win_observe_only'] = 1
                else:
                    current_point['win_observe_only'] = 0
                
    
    def percentage_check(self, check_point, start_index, percentage, verify_name, n):
        price = self.data[start_index]['zxj']
        up_per = int((1 + percentage/100) * price)
        down_per = int((1 - percentage/100) * price)
        up_col_name = f'up_index_{verify_name}_{percentage}'
        down_col_name = f'down_index_{verify_name}_{percentage}'
        if verify_name == "observe":
            utils.log(up_col_name)
        for i in range(start_index+1, n):
            if self.data[i]['zxj'] >= up_per and up_col_name not in check_point:
                check_point[up_col_name] = i
            if self.data[i]['zxj'] <= down_per and down_col_name not in check_point:
                check_point[down_col_name] = i
            
            if up_col_name in check_point and down_col_name in check_point:
                col_name = f'win_{verify_name}_{percentage}_per'
                if check_point['next_direction'] == 'up':
                    if check_point[up_col_name] < check_point[down_col_name]:
                        check_point[col_name] = 1
                    else:
                        check_point[col_name] = 0
                elif check_point['next_direction'] == 'down':
                    if check_point[up_col_name] > check_point[down_col_name]:
                        check_point[col_name] = 1
                    else:
                        check_point[col_name] = 0
                        
                break

    def output_metrics(self):
        prefix = f"{self.past_x_hours}_{self.candidate_x_min}_{self.precheck_x_min}"
        results = []
        for i in range(0, len(self.check_points)):
            data = self.check_points[i]
            result = {"prefix": prefix}
            result.update(data)
            result['date'] = data['time'].strftime('%Y-%m-%d')
            result["time"] = data['time'].strftime('%H:%M:%S')
            result['add_candidate_time'] = data['add_candidate_time'].strftime('%H:%M:%S')
            results.append(result)
        
        return results

    def print_metrics(self):
        prefix = f"{self.past_x_hours}_{self.precheck_x_min}"
        results = []
        for i in range(0, len(self.check_points)):
            data = self.check_points[i]
            result, max_value, min_value, max_win, max_loss, future_zxj = 0, 0, 0, 0, 0, 0
            is_overlap = False
            trade_time = "9999"
            # utils.log(
            #     f"{data['code']} {data['time']} {data['extreme_type']} {'precheck_extreme' in data} {data['zxj']} {data['add_candidate_zxj']} {future_zxj} {result} {max_win} {max_loss} {data['before_slope']} {data['after_slope']} {data['correlation']} {data['lr_zxj']} {data['lr_ccl']}")
            data['prefix'] = prefix
            results.append(data)

            # f"{prefix} {data['code']} {data['time'].strftime('%Y-%m-%d %H:%M:%S')} {data['add_candidate_time'].strftime('%H:%M:%S')} {trade_time} {data['extreme_type']} {'precheck_extreme' in data} {is_overlap} {data['zxj']} {data['add_candidate_zxj']} {future_zxj} {result} {max_win} {max_loss} {data['before_slope']} {data['after_slope']} {data['correlation']} {data['lr_zxj']} {data['lr_ccl']}")
        result_win = sum([result['result'] for result in results])
        result_true_win = sum([result['result']
                               for result in results if result['precheck_extreme']])
        statistic = {
            "prefix": prefix,
            "all_count": len(results),
            "precheck_count": len(self.precheck_check_points),
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

        abnormal_data = [d for d in dp.data if 'anomaly' in d and d['anomaly'] == "start"]
        abnormal_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in abnormal_data]
        abnormal_values = [point[check_column_name]
                          for point in abnormal_data]
        axs[i].scatter(abnormal_times, abnormal_values, color='green', label='Abnormal Points')   # type: ignore

        abnormal_cold_data = [d for d in dp.data if 'anomaly' in d and d['anomaly'] == "cold"]
        abnormal_cold_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in abnormal_cold_data]
        abnormal_cold_values = [point[check_column_name]
                          for point in abnormal_cold_data]
        axs[i].scatter(abnormal_cold_times, abnormal_cold_values, color='red', label='Abnormal Points')   # type: ignore


        candidate_times = [data['time'].strftime(
            '%Y-%m-%d %H:%M:%S') for data in dp.check_points]
        candidate_values = [point[check_column_name]
                            for point in dp.check_points]
        axs[i].scatter(candidate_times, candidate_values,   # type: ignore
                       color='blue', label='Candidate Points')
        
        # precheck_candidate_times = [data['time'].strftime(
        #     '%Y-%m-%d %H:%M:%S') for data in dp.precheck_check_points]
        # precheck_candidate_values = [point[check_column_name]
        #                              for point in dp.precheck_check_points]
        # axs[i].scatter(precheck_candidate_times, precheck_candidate_values, # type: ignore
        #                color='lime', label='Candidate Points')

        axs[i].set_title(f'{dp.past_x_hours} hours range - {dp.precheck_x_min} mins check:  Observe pass num: {len(dp.observe_passed_points)}') # type: ignore
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
            dps.append(DataProcessor(past_x_hour, precheck_x_min, check_column_name=check_column_name, precheck_min_slope_value=precheck_min_slope_value, precheck_accept_slope_value=precheck_accept_slope_value))
    return dps


def prepare_dps_simple(check_column_name="ccl"):
    dps = []
    dps.append(DataProcessor(past_x_hour=6, precheck_x_min=30, check_column_name=check_column_name, precheck_min_slope_value=350, precheck_accept_slope_value=600))
    return dps


def process_data(dps, start_date, end_date, contract_type="rb", verify_name="verify", is_draw_image=False, check_column_name="ccl"):
    span_type = "5sec"

    # final_results = []
    # statistics = []
    ticks = []
    for dp in dps:
        ticks = ticks_helper.get_ticks(
            start_date, end_date, contract_type, span_type)
        utils.log("get {} ticks".format(len(ticks)))
        for data in ticks:
            dp.process_new_data(data)

        utils.log("Finish process data")
        useful_data = [d for d in dp.data if len(d) > 12]
        utils.convert_dic_to_csv(f"v3_useful", useful_data)
        utils.convert_dic_to_csv(f"v3_all", dp.data)

    # utils.echo_dics(statistics)
    # utils.convert_dic_to_csv(f"{verify_name}", final_results)
    # utils.convert_dic_to_csv(f"{verify_name}_statistic", statistics)
    if is_draw_image:
        draw_image(dps, ticks, check_column_name=check_column_name)

def output_data(dp, start_date, end_date, contract_type = "rb", check_column_name="ccl"):
    span_type = "5sec"
    ticks = ticks_helper.get_ticks(
        start_date, end_date, contract_type, span_type)
    utils.log("get {} ticks".format(len(ticks)))
    for data in ticks:
        dp.process_new_data(data)


    # utils.convert_dic_to_csv(f"v3_with_abnormal", dp.data)
    useful_data = [d for d in dp.data if len(d) > 12]
    utils.convert_dic_to_csv(f"v3_useful", useful_data)

if __name__ == "__main__":
    # process_data("2022-05-01", "2022-08-01")
    check_column_name = "ccl"

    # 处理测试数据
    # round 1
    # dps = prepare_dps(check_column_name)
    # process_data(dps, "2022-04-20", "2022-08-01",verify_name="verify_05_08", check_column_name=check_column_name)

    # round 2
    # dps = prepare_dps_simple(check_column_name)



    dps = [
        DataProcessor(past_x_hour=2, candidate_x_min=5,  precheck_x_min=30, check_column_name=check_column_name, precheck_min_slope_value=350, precheck_accept_slope_value=600),
    ]
    process_data(dps, "2022-11-01", "2022-11-11", verify_name="verify_09_12",
                 check_column_name=check_column_name, is_draw_image=True)
    

    # dp = DataProcessor(past_x_hour=3, candidate_x_min=5,  precheck_x_min=30, check_column_name=check_column_name, precheck_min_slope_value=350, precheck_accept_slope_value=600)
    # output_data(dp=dp, start_date="2022-11-01", end_date="2022-11-20", contract_type="rb", check_column_name=check_column_name)
    # round 3
    # dps = prepare_dps(check_column_name)
    # process_data(dps, "2021-12-01", "2022-03-10", verify_name="verify_12_03", check_column_name=check_column_name)

    # draw_image(dps, ticks, check_column_name)
