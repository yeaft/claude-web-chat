import click
import json
import time
import os

from constance import *
from trigger_helper import *
from fn_fit import fit
from custom_curve_fit import sin_fit
from pymongo import MongoClient, DESCENDING, ASCENDING
from abc import ABC, abstractmethod
from trigger_intraday_abc import trigger_intraday_abc
from statistics import mean, variance, stdev


# open price， avg diff per last diff per and fluctuation？
# close price， avg diff per last diff per and fluctuation？
# if not trigger cut then how？
class trigger_intraday_basic(trigger_intraday_abc):

    def __init__(self):
        self.name = "intraday"
        self.initial_best_trigger_cut_factor_map()
        self.fluctuation_data = {}
        self.peak_infos = []
        self.trade_infos = []
        self.open_price = 0
        self.open_direction = ""
        self.trading = False
        self.extra_trade_count = 0
        self.trade_num = 0
        self.trigger_time = ""
        self.trigger_peak_time = ""
        self.trade_info = {}
        self.last_peak_info = {}
        self.peak_win_diff = 0
        self.code_peak_start_index_map = {}
        self.trade_fluctuation = ""
        self.open_price_history = []
        self.hold_prices = []
        self.close_info = []
        self.open_time_history = []
        self.close_time_history = []
        self.peak_win_diff_history = []
        self.position_count = 0
        self.last_peak_end_index = 0
        self.peak_past_num = 20
        self.last_ref_open_price = 0
        # self.next_step = 0
        self.code=""
        self.extra_open_diff = 0
        self.allow_trade = True
        self.continue_cut = False
        self.must_cut = False
        self.must_cut_price = 0
        self.max_extra_trade_count = 2000
        self.continue_cut_info = {}
        super().__init__()

    def process_factors(self):
        if self.factors != "":
            factor_arr = self.factors.split(":")[-1].split(",")
            # click.echo(factor_arr)
            self.trigger_stdev_rate = float(factor_arr[0])
            self.start_cut_hold_num = int(factor_arr[1])
            self.start_cut_peak_diff = float(factor_arr[2])
            self.must_cut_range_num = float(factor_arr[3])
            self.extra_open_rate = float(factor_arr[4])
            self.peak_diff_rate = float(factor_arr[5])
            self.peak_win_rate = float(factor_arr[6])
            self.min_fluctuation_range = float(factor_arr[7])
            self.min_ccl_diff = float(factor_arr[8])
            self.allow_position_count = float(factor_arr[9])
            self.max_extra_trade_count = 2000

    def initial_custom_data(self):
        start_time = time.time()
        if len(self.ticks) == 0 :
            return
        file_name = 'fluctuation_peaks_{}_all.json'.format(self.contract)
        if os.path.exists(file_name):
            with open(file_name) as json_file:
                self.fluctuation_peaks = json.load(json_file)
            
            for f in range(50, 110, 5):
                fluctuation_range = str(f / 10000)
                for code in self.codes:
                    if code not in self.code_peak_start_index_map:
                        self.code_peak_start_index_map[code] = {}
                    self.code_peak_start_index_map[code][fluctuation_range] = 21
        # click.echo("Finish initialize fluctuation peaks, using {}s".format(round(time.time()- start_time)))

    def calculate_all_peak_by_code(self):
        peaks = {}
        tick_main_col = MongoClient(MONGODB_CONNECTION_STRING).future["tick_{}_main".format(self.contract)]
        tick_second_col = MongoClient(MONGODB_CONNECTION_STRING).future["tick_{}_second".format(self.contract)]
        for code in self.codes:
            main_ticks = list(tick_main_col.find({"code": code}).sort("time", ASCENDING))
            end_time = main_ticks[0]['time']
            ticks = list(tick_second_col.find({"code": code, "time": {"$lt": end_time}}).sort("time", ASCENDING))
            ticks.extend(main_ticks)
            peaks[code] = self.calculate_sub_peaks(ticks)

        with open('fluctuation_peaks_{}_all.json'.format(self.contract), 'w') as outfile:
            json.dump(peaks, outfile)

    def calculate_sub_peaks(self, ticks):
        start_time = time.time()
        fluctuation_peaks_info = {}
        for f in range(50, 110, 5):
            fluctuation_range = str(f / 10000)
            self.generate_peak_info(fluctuation_range, ticks)
            fluctuation_peaks_info[fluctuation_range] = self.peak_infos
            self.peak_infos = []
        click.echo("Finish sub ticks {} {} using {}s".format(ticks[0]['code'], len(ticks), round(time.time() - start_time, 2)))
        return fluctuation_peaks_info
    # 1. 得到过去的波动
    # 2. 找到当前的位置，是否可以确定之前波动
    # 3. 之前没有开过仓
    # 4. 确定是抓大龙还是抓大龙反弹，还是每次都做
    # 5. 设置开仓价1
    # 6. 设置开仓价2
    # 7. 设置开仓价3
    # 8. 确定平仓 
    def meet_trigger(self):
        # click.echo("jkp {}, jsp {}, rate {}, target rate {}".format(self.info['jkp'], self.info['jsp'], (self.info['jsp'] - self.info['jkp']) / self.info['jkp'], self.jsp_diff_threshold))
        self.current_price = self.tick['zxj']

        # 1. 找到自己的peakInfo index和上一个peak
        fluctuation_range = str(self.min_fluctuation_range)
        fluctuation_range_num = float(fluctuation_range)
        peaks = self.fluctuation_peaks[self.tick['code']][fluctuation_range]
        peak_start_index = self.code_peak_start_index_map[self.tick['code']][fluctuation_range]
        found_peak_index = False
        for p_i in range(peak_start_index, len(peaks) - 1):
            peak = peaks[p_i]
            next_peak = peaks[p_i + 1]
            if self.tick['time'] <= peak['time']:
                break
            if self.tick['time'] > peak['time']:
                if self.tick['time'] < next_peak['time']:
                    self.code_peak_start_index_map[self.tick['code']][fluctuation_range] = p_i
                    found_peak_index = True
                    # temp_time =  next_peak['time'].split(".")[0]                    
                    # self.next_step = self.time_map[temp_time]
                    break
                else:
                    # 有可能当前时间是大于最后的peak的，没有小于next_peak的情况
                    self.code_peak_start_index_map[self.tick['code']][fluctuation_range] = p_i + 1
                    found_peak_index = True

        if not found_peak_index:
            return False       

        last_peak = self.fluctuation_peaks[self.tick['code']][fluctuation_range][self.code_peak_start_index_map[self.tick['code']][fluctuation_range]]
        last_peak_index = self.code_peak_start_index_map[self.tick['code']][fluctuation_range]
        # 之前已经cut过

        if self.trading:
            if self.trade_info['peakStartIndex'] > last_peak_index:
                if len(self.trade_infos) > 0:
                    self.trade_infos.pop()
                self.finish()
            else:
                # 重新计算avg diff
                change_peak = self.calculate_diffs(last_peak_index, fluctuation_range)
                # 可能第二次突破
                # if last_peak['time'] == self.trigger_peak_time:
                # 每次都重新计算open price
                # 额外交易
                last_ref_extra_open_price = self.last_ref_open_price + -1 * (self.extra_open_diff / 100) * last_peak['price']
                extra_open_price = self.open_price_history[-1] + -1 * (self.extra_open_diff / 100) * last_peak['price']
                # Now we ignore peak span as open condition
                if len(self.hold_prices) >= self.start_cut_hold_num:
                    self.trade_info['exceedMaxHold'] = True
                    extra_open_price = last_ref_extra_open_price
                if ((self.open_direction == "up" and self.tick['zxj'] <= extra_open_price) or (self.open_direction == "down" and self.tick['zxj'] >= extra_open_price)):                    
                    # What is the strategy to extra open?

                    # Trigger extra open, but hold position is over than max hold num
                    if ((self.open_direction == "up" and self.tick['zxj'] <= last_ref_extra_open_price) or (self.open_direction == "down" and self.tick['zxj'] >= last_ref_extra_open_price)):
                        self.last_ref_open_price = self.tick['zxj']
                        self.extra_trade_count += 1

                    # Extra open condition, should add condition?
                    # 1. less than max hold num
                    # 2. less than max peak span, remove this, but should increase trigger threshold and extra open threshold
                    # else trigger must cut or use dynamic cut?
                    if len(self.hold_prices) < self.start_cut_hold_num and last_peak_index - self.trade_info['peakStartIndex'] < self.start_cut_peak_diff:
                        self.open_price_history.append(self.tick['zxj'])
                        self.hold_prices.append(self.tick['zxj'])
                        self.open_time_history.append(self.tick['time'].replace(" ", "-"))
                        self.open_price = round((self.tick['zxj'] + self.position_count * self.open_price) / (1 + self.position_count), 1)
                        self.position_count += 1
                        self.trade_info['maxHolds'] = max(self.trade_info['maxHolds'], len(self.hold_prices))
                    else:
                        self.must_cut = True
                        rate = 1 if self.open_direction == "up" else -1
                        self.must_cut_price = (1 + rate * self.must_cut_range_num * fluctuation_range_num) * self.tick['zxj']
                        # self.must_cut_price = self.tick['zxj']
                        # self.cut(self.tick['zxj'], -1, "mustCut")
                else:
                    #进行平仓
                    #1. must cut
                    #2. in reverse peak to cut
                    if self.must_cut:
                        if not self.cut(self.must_cut_price, -1, "mustCut"):
                            if self.continue_cut and len(self.continue_cut_info) > 0:
                                if self.cut(self.continue_cut_info['cutPrice'], -1, "continueCut", True):
                                    self.continue_cut = False
                                    self.continue_cut_info = {}

                    if last_peak['time'] != self.trigger_peak_time and ((self.open_direction == "down" and last_peak['type'] == "crest") or (self.open_direction == "up" and last_peak['type'] == "trough")):
                        # Loss more then win cut more， 30%（x） past crest and trough diff
                        if len(self.hold_prices) >= self.start_cut_hold_num:
                            self.continue_cut = True
                        
                        if self.continue_cut:
                            self.update_continue_cut_info(last_peak, last_peak_index, fluctuation_range)                            
                            if self.cut(self.continue_cut_info['cutPrice'], -1, "continueCut", True):
                                self.continue_cut = False
                                self.continue_cut_info = {}

                        # 止盈
                        if change_peak:
                            self.peak_win_diff_history.append(round(self.peak_win_diff, 4))
                        cut_price = (1 + self.peak_win_diff / 100) * last_peak['price']
                        self.cut(cut_price, -1, "peakWinCut")
                    
                if len(self.hold_prices) == 0:
                    close_price = float(self.close_info[-1].split("-")[1])
                    self.trade_info['peakWinDiffHistory'] = " ".join(list(str(x) for x in self.peak_win_diff_history))
                    self.trade_info['peakWinDiff'] = self.peak_win_diff
                    self.trade_info['direction'] = self.open_direction
                    self.trade_info['openPrice'] = self.open_price
                    self.trade_info['closePrice'] = close_price
                    self.trade_info['triggerTime'] = self.trigger_time
                    self.trade_info['closeTime'] = self.tick['time']
                    self.trade_info['cutPeakTime'] = last_peak['time']
                    self.trade_info['cutPeakPrice'] = last_peak['price']
                    self.trade_info['peakEndIndex'] = last_peak_index
                    self.trade_info['peakDiff'] = self.trade_info['peakStartIndex'] - last_peak_index
                    self.trade_info['openTimeHistory'] = " ".join(list(str(x) for x in self.open_time_history))
                    self.trade_info['openPriceHistory'] = " ".join(list(str(x) for x in self.open_price_history))
                    self.trade_info['closePriceHistory'] = " ".join(list(str(x) for x in self.close_info))
                    self.trade_info['closeTimeHistory'] = " ".join(list(str(x) for x in self.close_time_history))
                    self.trade_info['extraTradeCount'] = self.extra_trade_count
                    self.trade_info['positionCount'] = self.position_count
                    
                    rate = 1 if self.open_direction == "up" else -1
                    self.result_per = rate * (close_price - self.open_price) / self.open_price
                    self.trade_info['resultPer'] = round(self.result_per, 4) + 1
                    contract_type_time = contract_type_times(self.contract)
                    self.trade_info['resultOneRealPer'] = round(1 + self.result_per * contract_type_time, 4)
                    sum_result_per = 0
                    for close_info in self.close_info:
                        info_arr = close_info.split("-")
                        o_p = float(info_arr[0])
                        c_p = float(info_arr[1])
                        sum_result_per += (1 + contract_type_time * rate * (c_p - o_p) / o_p)
                    self.trade_info['resultRealPer'] = round(sum_result_per / len(self.close_info), 4)
                    self.trade_info['resultRealMeanPer'] = round((self.trade_info['resultRealPer'] - 1) * self.trade_info['positionCount'] / self.start_cut_hold_num + 1 , 4)
                    self.finish()
        else:
            # 大龙反弹        
            price_diff = abs(last_peak["price"] - self.current_price) / last_peak["price"]
            if price_diff * 100 < 2:
                return False

            ccl_diff_per = round((self.tick['ccl'] - last_peak["ccl"]) * 100 / last_peak["ccl"], 2)
            trigger_diff = self.calculate_trigger_diff(last_peak_index, fluctuation_range)

            if price_diff * 100 > trigger_diff and ccl_diff_per > self.min_ccl_diff:
            # if price_diff_per > self.price_diff_rate:
                self.complete_trade_info()
                self.trigger_peak_time = last_peak['time']
                self.open_price = self.current_price
                self.last_ref_open_price = self.current_price
                self.open_direction = "down" if self.current_price > last_peak['price'] else "up"
                self.open_price_history.append(self.current_price)
                self.hold_prices.append(self.current_price)
                self.open_time_history.append(self.tick['time'].replace(" ", "-"))
                self.position_count = 1
                # rate = 1 if self.current_price > last_peak['price'] else -1
                # self.second_open_price = (1 + rate * self.second_diff_rate) * self.current_price
                self.trigger_time = self.tick['time']
                self.trading = True
                self.trade_info['contractCode'] = self.tick['code']
                self.trade_info['fluctuation'] = fluctuation_range_num
                self.trade_info['triggerPriceDiff'] = round(price_diff * 100, 2)
                self.trade_info['triggerCclDiff'] = ccl_diff_per                
                self.trade_info['triggerPeakTime'] = last_peak["time"]
                self.trade_info['triggerPeakType'] = last_peak["type"]
                self.trade_info['triggerPeakPrice'] = last_peak["price"]
                self.trade_info['peakStartIndex'] = last_peak_index
                self.trade_info['maxHolds'] = 1
                self.trade_fluctuation = fluctuation_range
                self.allow_trade = False
                self.trade_infos.append(self.trade_info)

        return False

    def update_continue_cut_info(self, last_peak, last_peak_index, fluctuation_range):
        # check if change continue cut info
        # 1. no cut info
        # 2. direction up, but current price is lower than last peak
        # 3. direction down, but current price is higher than last peak
        if len(self.continue_cut_info) == 0 or (self.open_direction == "up" and self.continue_cut_info['peakPrice'] > last_peak['price']) or (self.open_direction == "down" and self.continue_cut_info['peakPrice'] < last_peak['price']):
            sub_peak_infos = self.fluctuation_peaks[self.tick['code']][fluctuation_range][max(0, last_peak_index - 30): last_peak_index]
            reverse_peak_price = max(list(p['price'] for p in sub_peak_infos)) if self.open_direction == "up" else min(list(p['price'] for p in sub_peak_infos))
            peak_price_diff = abs(reverse_peak_price - last_peak['price']) * self.peak_diff_rate
            cut_price = last_peak['price'] + peak_price_diff if self.open_direction == "up" else last_peak['price'] - peak_price_diff
            self.continue_cut_info['peakPrice'] = last_peak['price']
            self.continue_cut_info['cutPrice'] = cut_price

    def cut(self, price, left_num = 0, cut_type = "", must_win=False):
        if left_num >= len(self.hold_prices):
            return False
        cut_prices = []
        if self.open_direction == "up":
            if self.tick['zxj'] >= price:
                for i in range(len(self.hold_prices)-1, left_num, -1):
                    if (must_win and self.hold_prices[i] <= price) or not must_win:
                        cut_prices.append(self.hold_prices[i])
        elif self.open_direction == "down":
            if self.tick['zxj'] <= price:
                for i in range(len(self.hold_prices)-1, left_num, -1):
                    if (must_win and self.hold_prices[i] >= price) or not must_win:
                        cut_prices.append(self.hold_prices[i])

        if len(cut_prices) > 0:
            self.close_time_history.append(self.tick['time'])
            for p in cut_prices:
                self.hold_prices.remove(p)
                self.close_info.append("{}-{}".format(p, self.tick['zxj']))
            
            self.trade_info['cutType'].append(cut_type+"-{}".format(len(cut_prices)))
            return True
        return False

    def calculate_trigger_diff(self, last_peak_index, fluctuation_range):
        consider_peak_start_index = max(1, last_peak_index - 2 * self.peak_past_num - 1)
        sub_peak_infos = self.fluctuation_peaks[self.tick['code']][fluctuation_range][consider_peak_start_index: last_peak_index+1]
        if self.open_direction == "up":
            sub_peaks = list(x['diffPer'] for x in sub_peak_infos if x['diffPer'] > 0)
        else:
            sub_peaks = list(x['diffPer'] for x in sub_peak_infos if x['diffPer'] < 0)

        trigger_diff = abs(mean(sub_peaks)) +  self.trigger_stdev_rate * stdev(sub_peaks)

        return trigger_diff

    def calculate_diffs(self, last_peak_index, fluctuation_range):
        consider_peak_start_index = max(1, last_peak_index - 2 * self.peak_past_num - 1)
        change_peak = False
        if self.last_peak_end_index != last_peak_index:
            sub_peak_infos = self.fluctuation_peaks[self.tick['code']][fluctuation_range][consider_peak_start_index: last_peak_index+1]
            rate = 1
            if self.open_direction == "up":
                sub_peaks = list(x['diffPer'] for x in sub_peak_infos if x['diffPer'] > 0)
            else:
                sub_peaks = list(x['diffPer'] for x in sub_peak_infos if x['diffPer'] < 0)
                rate = -1

            avg_sub_peaks = abs(mean(sub_peaks))
            stdev_sub_peaks = stdev(sub_peaks)
            self.peak_win_diff = (avg_sub_peaks + self.peak_win_rate * stdev_sub_peaks) * rate
            self.extra_open_diff = (avg_sub_peaks + self.extra_open_rate * stdev_sub_peaks) * rate
            self.last_peak_end_index = last_peak_index
            change_peak = True
        
        return change_peak

    def initial_best_trigger_cut_factor_map(self):
        file_name = 'best_type_factors_{}.json'.format(self.name)
        click.echo(file_name)
        if os.path.exists(file_name):
            with open(file_name) as json_file:
                self.best_trigger_cut_factor_map = json.load(json_file)
                
    # 需要从后往前，找到peak_num * 2 + 1个
    def generate_peak_info(self, fluctuation_range, ticks):
        start_time = time.time() 
        fluctuation_range = float(fluctuation_range)       
        # if missing tick?
        self.peak_infos = []
        # if len(self.peak_infos) > 0:
        #     self.peak_infos.sort(key=lambda x: x['time'], reverse= True)
        find_first = False
        trough_peak = {"price":999999, "type":"trough"}
        crest_peak = {"price":0, "type":"crest"}
        next_peak = {}
        for i in range(len(ticks) - 1, 0, -1):
            t = ticks[i]
            current_price = t['zxj']
            peak_info = {
                "index": 0,
                "time": t['time'],
                "price": current_price,
                "cjl": t['cjl'],
                "ccl": t['ccl']
            }

            if not find_first:
                if current_price >= crest_peak['price']:
                    crest_peak.update(peak_info)
                if current_price <= trough_peak['price']:
                    trough_peak.update(peak_info)
                
                # Detect the first peak
                if (crest_peak['price'] - trough_peak['price']) / trough_peak['price'] >= fluctuation_range:
                    if crest_peak['price'] == current_price:
                        self.peak_infos.append(trough_peak)
                        next_peak = crest_peak
                    else:
                        self.peak_infos.append(crest_peak)
                        next_peak = trough_peak
                    find_first = True            
            else:
                next_peak_price = next_peak['price']
                potensial_peak_type = "crest" if current_price - next_peak_price > 0 else "trough"
                if next_peak['type'] != potensial_peak_type:
                    if abs(current_price - next_peak_price) / next_peak_price >= fluctuation_range:
                        # 当前peak确定，则可以确定已记录的peak的diff
                        # click.echo("{}, {}, {}, {}".format(t['time'], t['zxj'], last_peak_price, potensial_peak_type))
                        self.peak_infos[-1]['diff'] = self.peak_infos[-1]['price'] - next_peak_price
                        self.peak_infos[-1]['diffPer'] = round((self.peak_infos[-1]['price'] - next_peak_price) * 100 / next_peak_price, 2)
                        # Two peaks past, so direction is during this peak, not the next
                        self.peak_infos[-1]['nextDirection'] = "up" if self.peak_infos[-1]['type'] == "trough" else "down"                        
                        self.peak_infos[-1]['changeLevel'] = round(abs(self.peak_infos[-1]['diffPer']) / (100 * fluctuation_range), 2)

                        # 插入当前peak
                        self.peak_infos.append(next_peak)
                        # 如果满足个数，那么排序退出
                        # if len(self.peak_infos) >= 2 * self.peak_win_diff_past_num + 1:
                        #     self.peak_infos.sort(key=lambda x: x['time'])
                        #     # echo_dics(self.peak_infos)
                        #     break

                        # 开启新的peak查找
                        next_peak = peak_info
                        next_peak['type'] = potensial_peak_type
                else:
                    next_peak.update(peak_info)

        self.peak_infos.sort(key=lambda x: x['time'])
        count = 0
        for peak_info in self.peak_infos:
            peak_info['index'] = count
            count += 1
        
        click.echo("Finish get peaks using {}s".format(round(start_time - time.time(), 2)))

    def generate_trigger_factors(self):
        factors = []
        for trigger_stdev_rate in [2.5, 3, 4, 5]:
            for start_cut_hold_num in [1, 3]:
                for start_cut_peak_diff in [3, 5]:
                    for must_cut_range_num in [0.5, 1, 2]:
                        for extra_open_rate in [2, 3, 4]:
                            for peak_diff_rate in [0.5, 1, 2]:
                                for peak_win_rate in [3, 4]:
                                    for min_fluctuation_range in [0.007, 0.0075, 0.008, 0.0085, 0.0095]:
                                        for min_ccl_diff in [0]:
                                            for allow_position_count in [1]:
                                                factors.append("{},{},{},{},{},{},{},{},{},{}".format(trigger_stdev_rate, start_cut_hold_num, start_cut_peak_diff, must_cut_range_num, extra_open_rate, peak_diff_rate, peak_win_rate, min_fluctuation_range, min_ccl_diff, allow_position_count))
        return factors

    def custom_cut(self):
        return False

    def finish(self):
        self.trigger_time = ""
        self.open_price = 0
        self.open_direction = ""
        self.peak_win_diff = 0
        self.trade_info = {}
        self.trade_fluctuation = ""
        self.open_price_history = []
        self.hold_prices = []
        self.open_time_history = []
        self.peak_win_diff_history = []
        self.close_time_history = []
        self.close_info = []
        self.position_count = 0
        self.extra_trade_count = 0
        self.last_ref_open_price = 0
        self.extra_open_diff = 0
        self.last_peak_end_index = 0
        self.trading = False
        self.allow_trade = True
        self.must_cut = False
        self.must_cut_price = 0

def test_number():
    file_name = 'fluctuation_peaks_{}_{}_{}.json'.format("rb", "20210104", "20210226")
    with open(file_name) as json_file:
        fluctuation_peaks = json.load(json_file)
    datas = fluctuation_peaks['0.0075'][1:-2]
    up_change_levels = list(x['changeLevel'] for x in datas if x['diffPer'] > 0)
    down_change_levels = list(x['changeLevel'] for x in datas if x['diffPer'] < 0)
    statistics = calculate_statistic_value(up_change_levels)
    click.echo(statistics)
    statistics = calculate_statistic_value(down_change_levels)
    click.echo(statistics)

def check_diff():
    contract = "ma"
    file_name = 'fluctuation_peaks_{}_{}_{}.json'.format(contract, "20210106", "20210224")
    with open(file_name) as json_file:
        fluctuation_peaks = json.load(json_file)

    file_name = 'fluctuation_peaks_{}_{}_{}_real.json'.format(contract, "20210104", "20210226")
    with open(file_name) as json_file:
        fluctuation_peaks_real = json.load(json_file)

    real_data = list(x for x in fluctuation_peaks_real["0.0085"] if x['time'] >= "20210106 220000.000" and x['time'] <= "20210224 000000.000")
    bad_data = fluctuation_peaks['0.0085']
    with open('real_{}.json'.format(contract), 'w') as outfile:
        json.dump(real_data, outfile)
    
    with open('bad_{}.json'.format(contract), 'w') as outfile:
        json.dump(bad_data, outfile)
    click.echo("{} {}".format(len(real_data), len(bad_data)))

def initial_type_peak_infos(start_time, end_time):
    # types = ["rb", "ru", "i", "ap", "rm", "ma", "sp", "pp", "ta", "eb", "eg"]
    types = ["ma"]
    trigger = trigger_intraday_basic()
    for contract in types:
        # tick_main_col = MongoClient(MONGODB_CONNECTION_STRING).future["tick_{}_main".format(contract)]
        # ticks = list(tick_main_col.find({"time": {"$gte": start_time, "$lte": end_time}}))
        ticks = list(TICK_COL.find({"type":contract, "time": {"$gte": start_time, "$lte": end_time}}))
        trigger.set_data(ticks, "", contract)

if __name__ == "__main__":
    trigger = trigger_intraday_basic()
    # types = ['ag', 'al', 'ap', 'au', 'a', 'bb', 'bc', 'bu', 'b', 'cf', 'cj', 'cs', 'cu', 'cy', 'c', 'eb', 'eg', 'fb', 'fg', 'fu', 'hc', 'i', 'jd', 'jm', 'jr', 'j', 'lh', 'lr', 'lu', 'l', 'm',
    #          'ni', 'nr', 'oi', 'pb', 'pf', 'pg', 'pk', 'pm', 'pp', 'p', 'rb', 'ri', 'rm', 'rr', 'rs', 'ru', 'sa', 'sc', 'sf', 'sm', 'sn', 'sp', 'sr', 'ss', 'ta', 'ur', 'v', 'wh', 'wr', 'y', 'zc', 'zn']
    # types = ["i", "ru", "rb", "eb", "eg", "sp"]
    types = ["hc", "ma", "sa"]
    for contract in types:
        tick_main_col = MongoClient(MONGODB_CONNECTION_STRING).future["tick_{}_main".format(contract)]
        # ticks = list(tick_main_col.find())
        # trigger.ticks = ticks
        trigger.contract = contract
        trigger.codes = tick_main_col.distinct("code")
        trigger.calculate_all_peak_by_code()
    # test_number()
    # initial_type_peak_infos("20210104 090000", "20210226 150000")
    # check_diff()



