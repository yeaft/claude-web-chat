import random
import time
from collections import deque
from datetime import datetime, timedelta
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
from statistics import mean, variance, stdev

# contract status => [available,extremDetected, holding]
# mark result => [precheck pass, precheck fail, observe pass, observe fail]
# Observed
# prechecked


class DataProcessor:
    def __init__(self, cjl_column_name, cjl_past_num=60, cjl_period_num=3, send_message=False, real_send_message=False):
        self.win_cent = 0.005
        self.data = []
        self.max_data_size = 12 * 60 * 5.8 * 10  # ten days data
        self.send_message = send_message
        self.cjl_column_name= cjl_column_name
        # cjl abnormal
        self.cjl_past_num = cjl_past_num
        self.cjl_period_num = cjl_period_num
        self.real_send_message = real_send_message
        self.cjl_peaks = []
        self.zxj_peaks = []
        self.check_future_two_days = 12 * 60 * 5.8 * 2
        
    def initial_threshold(self):
        if self.data[-1]['type'] != "i":
            reference_price = int (self.data[-1]['zxj'] * 1.2)
        else:
            reference_price = int (self.data[-1]['zxj'] * 12)
            
        self.cjl_period_min_threshold = int(19000000/reference_price) * self.cjl_past_num / 60
        self.cjl_period_pass_threshold = int(34000000/reference_price) * self.cjl_period_num / 3
        self.cjl_hot_threshold = int(4500000 / reference_price) # threshold should be related to real money, 1000 * 4000 = 4 million
        self.must_away_cjl_threshold = int(240000000 / reference_price) # 40000 * 4000 = 160 million

    def validate_data(self, data):
        if self.cjl_column_name not in data:
            return False
        
        return True
        
    def process_new_data(self, tick):
        if not self.validate_data(tick):
            return
        
        self.data.append(tick)
        n = len(self.data)
        
        if n == 1:
            self.initial_threshold()
        elif n % 10000 == 0:
            utils.log(f"Processed {n} ticks") 

        # TODO start to record data
        tick['index'] = n - 1
        # Parse time
        if type(tick['time']) == str:
            tick['time'] = datetime.strptime(
                tick['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)

        
        # We don't have enough data for a 2-hour window and additional 3 minutes
        if n < self.cjl_past_num + self.cjl_period_num + 1:
            return

        self.start_process(n)

        # 1. 必须分析已过日期的状态，比如是大上涨趋势，还是下跌趋势。
        # 2. 收盘的ccl回落和价格走势有很大的指导意义
        #    2.1 如果子弹够，且趋势强硬，日内ccl提出后，价格依旧是追随趋势，那么第二天很有可能是继续强硬
        #    2.2 如果子弹以用满，且ccl大幅下滑，且价格大幅波动，那么第二天大概率是ccl下将的调整
        # 2. 把第二天的走势全部预测出来，比如如果要继续搞是怎么样，如果是休息等
        # 3. 检查前一天ccl和价格的相关性，也要看前一个相关性，用来判断交易的情况

    def send_cjl_abnormal_signal(self, is_send = False):

        message = f"{self.data[-1]['time'].date()} {self.data[-1]['time'].time()}\n"
        message += f"{self.data[-1]['code']} CJL abnormal {self.data[-1]['anomaly']}\n"
        duration_seconds = (self.data[-1]['time'] - self.cjl_ab_start_data['time']).total_seconds()
        index_diff = int(duration_seconds / 5) + 3
        if self.data[-1]['anomaly'] == "end":
            if self.data[-1]['type'] != "i":
                message += f"Dur: {int(duration_seconds)}s PD: {int(self.data[-1]['zxj'] - self.data[-index_diff]['zxj'])}\n"            
                message += f"{int(self.data[-index_diff]['zxj'])} {int(self.data[-1]['zxj'])} {int(max([d['zxj'] for d in self.data[-index_diff:]]))} {int(min([d['zxj'] for d in self.data[-index_diff:]]))}\n"
            else:
                message += f"Dur: {int(duration_seconds)}s PD: {round(self.data[-1]['zxj'] - self.data[-index_diff]['zxj'], 1)}\n"            
                message += f"{round(self.data[-index_diff]['zxj'] * 2)/2} {round(self.data[-1]['zxj']*2)/2} {round(max([d['zxj'] for d in self.data[-index_diff:]]) * 2)/2} {round(min([d['zxj'] for d in self.data[-index_diff:]])*2)/2}\n"
            message += f"CJL sum: {int(sum([d[self.cjl_column_name] for d in self.data[-index_diff:]]))}\n"
            message += f"CCL Diff: {int(self.data[-1]['ccl'] - self.cjl_ab_start_data['ccl'])}\n"
        # message += f"ZXJ L:{self.past_30min_price_trend:<4} S:{self.data[-1]['ab_zxj_direction']:<5}\n"
        # message += f"CCL L:{self.past_30min_ccl_trend:<4} S:{self.data[-1]['ab_ccl_direction']:<5}\n"

        for i in range(len(self.data)-index_diff, len(self.data)):
            if self.data[-1]['type'] != "i":
                message += f"{int(self.data[i]['zxj']):<5} {int(self.data[i][self.cjl_column_name]):<5} {(self.data[i]['anomaly'] if 'anomaly' in self.data[i] else ''):<7}\n"        
            else:
                message += f"{round(self.data[i]['zxj']*2)/2:<5} {int(self.data[i][self.cjl_column_name]):<5} {(self.data[i]['anomaly'] if 'anomaly' in self.data[i] else ''):<7}\n"        

        utils.send_ding_msg(msg=message, is_real_send=is_send)

    def cjl_abnormal_check(self):
        if len(self.data) > self.cjl_past_num + self.cjl_period_num:
            start_time = time.time()
            past_cjl = [d[self.cjl_column_name] for d in self.data[-self.cjl_past_num-self.cjl_period_num:-self.cjl_period_num]]
            past_cjl_mean = np.mean(past_cjl)
            past_cjl_std = np.std(past_cjl)
            last_period_cjl_sum = sum([d[self.cjl_column_name] for d in self.data[-self.cjl_period_num:]])
            last_period_cjl = int(last_period_cjl_sum / self.cjl_period_num)
            # self.data[-1]['ab_zxj_direction'] = "up" if self.data[-1]['zxj'] > mean([d['zxj'] for d in self.data[-6:-1]]) else "down"
            # self.data[-1]['ab_ccl_direction'] = "up" if self.data[-1]['ccl'] > mean([d['ccl'] for d in self.data[-6:-1]]) else "down"
            
            night_rate = 0.9 if self.data[-1]['time'].hour >= 20 else 1
            if (last_period_cjl - past_cjl_mean > 3 * past_cjl_std and last_period_cjl_sum > self.cjl_period_min_threshold * night_rate) or last_period_cjl_sum > self.cjl_period_pass_threshold * night_rate:
                if 'anomaly' not in self.data[-2]:
                    self.data[-1]['anomaly'] = "start"
                    # Check past 2 mins slope
                    # self.data[-1]['past_2_mins_slope'] = round(self.slope_angle(self.data[-24], self.data[-1]), 2)
                    self.cjl_ab_start_data = self.data[-1]
                    # Generate suggestion
                    if self.send_message:
                        self.send_cjl_abnormal_signal(is_send=self.real_send_message)

                else:
                    if self.data[-1][self.cjl_column_name] >= self.cjl_hot_threshold * night_rate:
                        self.data[-1]['anomaly'] = "hot"
                    else:
                        self.data[-1]['anomaly'] = "cold"                
            else:
                contains_anomaly = False
                for i in range(2, 5):
                    if 'anomaly' in self.data[-i]:
                        if self.data[-i]['anomaly'] == "end":
                            break
                        elif self.data[-i]['anomaly'] != "cold":
                            contains_anomaly = True
                            break

                if contains_anomaly:
                    if self.data[-1][self.cjl_column_name] >= self.cjl_hot_threshold * night_rate:
                        is_colding = True
                        for i in range(2,5):
                            is_colding = 'anomaly' in self.data[-i-1] and self.data[-i][self.cjl_column_name] < self.data[-i-1][self.cjl_column_name]
                            if not is_colding:
                                break
                        
                        if is_colding:
                            self.data[-1]['anomaly'] = "colding"
                            # self.send_cjl_abnormal_signal(self.real_send_message)
                            
                        else:
                            contains_colding = False
                            for i in range(2, 5):
                                if 'anomaly' in self.data[-i] and self.data[-i]['anomaly'] == "colding":
                                    contains_colding = True
                                    break
                                
                            if contains_colding:
                                is_hotting = True
                                for i in range(2, 5):
                                    is_hotting = 'anomaly' in self.data[-i-1] and self.data[-i][self.cjl_column_name] > self.data[-i-1][self.cjl_column_name]
                                    if not is_colding:
                                        break
                                
                                if is_hotting:
                                    self.data[-1]['anomaly'] = "hotting"
                                    # self.send_cjl_abnormal_signal(self.real_send_message)                                    
                                else:
                                    self.data[-1]['anomaly'] = "hot"
                            else:
                                self.data[-1]['anomaly'] = "hot"
                    else:
                        if 'anomaly' in self.data[-2]:
                            if (self.data[-2]['anomaly'] in ["hotting", "colding", "hot", "start"] or "anomaly" not in self.data[-3] or ('anomaly' in self.data[-3] and self.data[-3]['anomaly'] in ["hotting", "colding", "hot", "start"])):
                                self.data[-1]['anomaly'] = "cold"
                            else:
                                self.data[-1]['anomaly'] = "end"
                                self.record_cjl_abnormal_peak()
                                if self.send_message:
                                    self.send_cjl_abnormal_signal(is_send=self.real_send_message)
                        else:
                            self.data[-1]['anomaly'] = "end"
                            self.record_cjl_abnormal_peak()
                            if self.send_message:
                                    self.send_cjl_abnormal_signal(is_send=self.real_send_message)
                                    
            # utils.log(f"Finish process one data point. use time: {round(time.time() - start_time,2)}s")

    def record_cjl_abnormal_peak(self):
        if 'anomaly' in self.data[-1] and self.data[-1]['anomaly'] == "end":
            start_time = time.time()
            # find latest anomaly = start index
            start_index = len(self.data) - 2
            while start_index >= 0:
                if 'anomaly' in self.data[start_index] and self.data[start_index]['anomaly'] == "start":
                    end_index = len(self.data) - 1
                    if end_index - start_index < 12:
                        break
                    
                    # get the direction
                    previous_avg_zxj = mean([d['zxj'] for d in self.data[start_index - 12:start_index]])
                    peak_avg_zxj = mean([d['zxj'] for d in self.data[start_index:start_index + 12]])
                    peak_index = start_index
                    
                    if peak_avg_zxj > previous_avg_zxj:
                        direction = "up"                        
                        for i in range(start_index, end_index):
                            if self.data[i]['zxj'] > self.data[peak_index]['zxj']:
                                peak_index = i
                    else:
                        direction = "down"
                        for i in range(start_index, end_index):
                            if self.data[i]['zxj'] < self.data[peak_index]['zxj']:
                                peak_index = i
                                
                    self.cjl_peaks.append(
                        {
                            "index": peak_index,
                            "peak_time": self.data[peak_index]['time'],
                            "peak_zxj": self.data[peak_index]['zxj'],
                            "peak_ccl": self.data[peak_index]['ccl'],
                            "direction": direction,
                            "open_direction": "up" if direction == "down" else "down",
                            "cjl_sum": int(sum([d[self.cjl_column_name] for d in self.data[start_index:end_index]])),
                            "start_index": start_index,
                            "end_index": end_index,
                            "time_diff": round((self.data[end_index]['time'] - self.data[start_index]['time']).total_seconds()/60, 1)
                        }
                    )
                    
                    break
                
                start_index -= 1
            
            # utils.log(f"Finish record abnormal peak. use time: {round(time.time() - start_time,2)}s")
            
                        
    def start_process(self, data_length):        
        self.cjl_abnormal_check()

    def output_statistic(self):
        extrems = analysis_helper.get_past_peaks(self.data, "zxj", 30 * 12)
        
        for cjl_peak in self.cjl_peaks:
            match_count = 0
            potential_zxj_peak_counts = 0
            potentia_times = []
            start_index = cjl_peak['index']
            end_index = int(self.check_future_two_days + start_index)
            for i in range(start_index, end_index):
                if cjl_peak['open_direction'] == "up":
                    if self.data[i]['zxj'] >= cjl_peak['peak_zxj'] * (1+self.win_cent):
                        match_count = 1
                        start_index = i
                        potentia_times.append(self.data[i]['time'])
                        break
                else:
                    if self.data[i]['zxj'] <= cjl_peak['peak_zxj'] * (1-self.win_cent):
                        match_count = 1
                        start_index = i
                        potentia_times.append(self.data[i]['time'])
                        break
            
            if match_count > 0:
                available_zxj_extrem = [e for e in extrems if e['index'] >= start_index and e['index'] <= end_index]
                for extrem in available_zxj_extrem:
                    if extrem['peak_type'] == "max" and cjl_peak['open_direction'] == "up":
                        potential_zxj_peak_counts += 1
                        potentia_times.append(extrem['time'])
                        if extrem['zxj'] >= cjl_peak['peak_zxj'] * (1+self.win_cent):
                            match_count += 1
                    elif extrem['peak_type'] == "min" and cjl_peak['open_direction'] == "down":
                        potential_zxj_peak_counts += 1
                        potentia_times.append(extrem['time'])
                        if extrem['zxj'] <= cjl_peak['peak_zxj'] * (1-self.win_cent):
                            match_count += 1                         
            
            cjl_peak['match_count'] = match_count
            cjl_peak['potential_zxj_peak_counts'] = potential_zxj_peak_counts
            cjl_peak['potentia_times'] = " ".join([str(t) for t in potentia_times])            
            
        
        # statistic match count larger than 0 number
        match_count_larger_than_0 = len([c for c in self.cjl_peaks if c['match_count'] > 0])
        utils.log(f"match_count_larger_than_0: {match_count_larger_than_0}, count: {len(self.cjl_peaks)}, rate: {round(match_count_larger_than_0*100.00/len(self.cjl_peaks), 2)}%")
            
        utils.convert_dic_to_csv(f"extrems", extrems, is_new=False)
        utils.convert_dic_to_csv(f"cjl_peaks", self.cjl_peaks, is_new=False)

if __name__ == "__main__":
    dp = DataProcessor(cjl_column_name="cjlDiff")
    ticks = ticks_helper.get_ticks("2023-10-20", "2023-11-01", "rb", "real", "rb2401")
    utils.log(f"ticks count: {len(ticks)}")
    
    for data in ticks:
        dp.process_new_data(data)
    
    dp.output_statistic()
        
    #TODO Optimize open direction
    
