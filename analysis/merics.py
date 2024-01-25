import numpy as np
import time
from sklearn.linear_model import LinearRegression
from statistics import mean, variance, stdev
import helper.statistic_utils as statistic_utils
from helper import constance, utils, date_utils, analysis_helper, ticks_helper, file_utils

class Metric:
    # Lowest means today is has the lowest value in the last 10 days, and current is not higher than 10% of daily waves
    # Highest is similar
    __ccl_status_values = ["Lowest", "Low", "Normal", "High", "Highest"]
    __ccl_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAdjust", "Up", "UpEnd"]
    __price_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAjust", "Up", "UpEnd"]
    __price_micro_trend_values = ["Down", "Adjust", "Up"]
    __cjl_status_values = ["Cold", "Warm", "Hot", "StartHot", "Cooling"]
    __contract_status_values = ["Long", "LongPullback", "Adjust", "ShortPullback", "Short"]
    __contract_trend_values = ["Long", "LongPullback", "Balance", "ShortPullback", "Short"]
    __close_ccl_trend_values = ["Down", "Adjust", "Up"]
    __close_price_trend_values = ["Down", "Adjust", "Up"]

    # if self.data[-1]['type'] != "i":
    #         reference_price = int (self.data[-1]['zxj'] * 1.2)
    #     else:
    #         reference_price = int (self.data[-1]['zxj'] * 12)
            
    #     self.cjl_period_min_threshold = int(23000000/reference_price)
    #     self.cjl_period_pass_threshold = int(34000000/reference_price)
    #     self.cjl_hot_threshold = int(4500000 / reference_price) # threshold should be related to real money, 1000 * 4000 = 4 million
    #     self.must_away_cjl_threshold = int(240000000 / reference_price) # 40000 * 4000 = 160 million
    #     self.ccl_day_diff_threshold = int(14000000/reference_price)
    #     self.ccl_hot_threshold = int(9000000/reference_price)
    
    __low_cjl_minute_threshold = 3000
    __hot_cjl_minute_threshold = 7700
    __five_minute_check_point_count = 5 * 12
    __six_hours_check_point_count = 6 * 60 * 12
    __balance_avg_to_min_max_price_diff_rate = 0.0008
    __balance_avg_to_min_max_ccl_diff_rate = 0.001
    __extreme_cols = ["zxj", "ccl", "cjlDiff"]
    
    def __init__(self):
        self.extremes_set = {}
        for col in self.__extreme_cols:
            self.extremes_set[col] = []

    '''
    定义：
        1. 状态分为平衡态和事件中，事件与事件之间平衡态可能很短暂
        2. 平衡态为低成交量，稳定的ccl变化，稳定的price变化
        3. 事件中则是ccl变化引导的price的变化
        4. 事件中的分类：
            1. 与当前大方向一致，顺势事件
            2. 与当前大方向不一致，回调事件
            3. 大方向的定义：ccl变化带动的price的变化的方向就是大方向：
                3.1 比如如果ccl变大，price也变大，那么就是看多的大方向。
                3.2 ccl变大，price变小，那么就是看空的大方向。
                3.3 ccl变小，price变大，那么就是大方向看空，但是现在是空调整，所以当前是多。
                3.4 ccl变小，price变小，那么就是大方向看多，但是现在是多调整，所以当前是空。
        4. 事件中又分为两个过程，第一个为正向过程，也就真正事件。第二个为逆向过程，ccl可能依旧是持续的但是价格放向却是相反（非健康走势的过热补偿），或者ccl相反，价格也相反（健康走势的回落）
        5. 价格和ccl的比值称为pc_rate，平衡态的pc_rate叫做平衡pc_rate
        6. 健康走势就是pc_rate在一定范围内
        7. 非健康走势就是pc_rate过大（多少是过大？），也就是ccl还没有跟着上涨cjl就开始回落了
        8. 非健康走势的结束就是pc_rate回归到健康走势的范围内或者cjl结束
        9. cjl结束为这次分钟的sum cjl低于高潮的分钟sum cjl的四分之一且低于一个阈值，每个点往前看1分钟

    预测：
        1. 事件过程中：
            1. 健康走势应该继续持有
            2. 非健康走势应该做反到回归正常的pc_rate或者cjl结束
            3. 每次的cjl结束后都应该平仓，或者开反
            4. cjl结束后可能是新的事件开始，也可能是进入平衡态
        2. 平衡态：
            1. 查看上一个cjl结束到当前平衡态的趋势，只要没有反转，那么就保持同向
        3. 额外补充：
            1. 如果每次cjl异常都是一个放向，那么说明当日的趋势很明显
            2. 无量走平又是高点，就是空的信号,有一定可能是的就是后面的大量交易，显得之前是无量，但是后面的大量交易必定是3日方向的
    '''

    def calculate_price_trend(self, tick_infos, day_infos):
        # 1. 绝对定义：时间范围内的价格和ccl稳定，且cjl很低
        # 2. 参考率: 单位ccl的价格变化
        pass

    def calculate_cjl_status(self, tick_infos, day_infos):
        pass

    def calculate_contract_status(self, tick_infos, day_infos):
        pass

    def calculate_contract_trend(self, tick_infos, day_infos):        
        pass
    
    def get_current_metrics(self, tick_infos): 
               
        metric = {}
        if len(tick_infos) < self.__six_hours_check_point_count:
            return metric
        
        # start_get_contract_status_time = time.time()
        # Get all extremes
        self.find_extremes(tick_infos)
        
        # 确定大方向
        
        # metric['contractStatus'] = self.get_contract_status(tick_infos)
        # print(f"get_contract_status cost {(time.time() - start_get_contract_status_time)*1000}ms")
        
        past_five_mins_ticks = tick_infos[-self.__five_minute_check_point_count:]
        cjls = [tick['cjlDiff'] for tick in past_five_mins_ticks if 'cjlDiff' in tick]
        metric['cjlStatus'] = self.get_cjl_status(cjls)
        metric['cjlTrend'] = self.get_trend_by_std(cjls, cjls[-3:], 1) if cjls[-1] >= 200 else "Adjust"

        prices = [tick['zxj'] for tick in past_five_mins_ticks]
        metric['zxjTrend1'] = self.get_trend(prices, 9, 12 * 5, self.__balance_avg_to_min_max_price_diff_rate)
        metric['zxjTrend2'] = self.get_trend_by_std(prices, prices[-6:], 1)
        
        ccls = [tick['ccl'] for tick in past_five_mins_ticks]
        metric['cclTrend1'] = self.get_trend(ccls, 9, 12 * 5, self.__balance_avg_to_min_max_ccl_diff_rate)
        metric['cclTrend2'] = self.get_trend_by_std(ccls, prices[-12:], 1)
        
        if metric['cjlStatus'] == "Cold" and self.is_balance(ccls, prices, cjls):
            metric['contractTrend'] = "Balance"
        else:
            self.get_event_trend(tick_infos, metric)
        
        # print(f"get_current_metrics cost {(time.time() - start_time)*1000}ms")
        return metric
    
    def get_trend(self, data, short_count, long_count, threshold):
        short_avg = sum(data[-short_count:]) / short_count
        long_avg = sum(data[-long_count:]) / long_count
        if short_avg > long_avg * (1 + threshold):
            if short_avg > long_avg * (1 + threshold * 3):
                return "FastUp"
            return "Up"
        elif short_avg < long_avg * (1 - threshold):
            if short_avg < long_avg * (1 - threshold * 3):
                return "FastDown"
            return "Down"
        else:          
            return "Adjust"
    
    def get_trend_by_std(self, longs, shorts, rate):
        long_avg = mean(longs)
        long_stdev = stdev(longs)
        short_avg = mean(shorts)
        if short_avg > long_avg + 2 * rate * long_stdev:
            return "FastUp"
        if short_avg >= long_avg + rate * long_stdev:
            return "Up"        
        if short_avg < long_avg - 2 * rate * long_stdev:
            return "FastDown"
        if short_avg <= long_avg - rate * long_stdev:
            return "Down"
        return "Adjust"
    
    def get_event_trend(self, tick_infos, metric):
        # cjl abnormal range, ccl peak, price peak
        # 先找到最近的一个cjl异常点，并得到大量成交范围，确定方向
        # 成交范围前可能就是平衡态
        start_index, end_index = self.get_lastest_max_cjl_range(tick_infos)
        if end_index - start_index < 12:
            return "Unknown", "Unknown"
        
        sub_ticks = tick_infos[start_index:end_index]
        max_cjl_tick = max(sub_ticks, key=lambda x: x['cjlDiff'])
        peak_index = -1
        if max_cjl_tick['zxj'] > tick_infos[start_index]['zxj']:
            zxj_trend = "Up"
            max_zxj = max(sub_ticks, key=lambda x: x['zxj'])['zxj']
            for i in range(start_index, end_index+1, 1):
                if tick_infos[i]['zxj'] == max_zxj:
                    peak_index = i
                    break
        else:
            zxj_trend = "Down"
            min_zxj = min(sub_ticks, key=lambda x: x['zxj'])['zxj']
            for i in range(start_index, end_index+1, 1):
                if tick_infos[i]['zxj'] == min_zxj:
                    peak_index = i
                    break
        
        start_ccls, start_zxjs = self.get_tick_infos_ccl_and_zxj(tick_infos, start_index-6, start_index+6)
        peak_ccls, peak_zxjs = self.get_tick_infos_ccl_and_zxj(tick_infos, peak_index-6, peak_index+6)
        end_ccls, end_zxjs = self.get_tick_infos_ccl_and_zxj(tick_infos, end_index-6, end_index+6)
        now_ccls, now_zxjs = self.get_tick_infos_ccl_and_zxj(tick_infos, -6, len(tick_infos))
        last_3mins_ccls, last_3mins_zxjs = self.get_tick_infos_ccl_and_zxj(tick_infos, -36, len(tick_infos)) 
        start_ccl_avg = mean(start_ccls)
        peak_ccl_avg = mean(peak_ccls)
        now_ccl_avg = mean(now_ccls)
        peak_zxj_avg = mean(peak_zxjs)
        peak_zxj_std = stdev(peak_zxjs)
        now_zxj_avg = mean(now_zxjs)
        ccl_trend = "Up" if peak_ccl_avg > start_ccl_avg else "Down"
        
        if zxj_trend == "Up":
            if now_zxj_avg >= peak_zxj_avg - 0.5 * peak_zxj_std:
                peak_2_now_zxj_trend = "Up"
            else:
                peak_2_now_zxj_trend = "Down"
        elif zxj_trend == "Down":
            if now_zxj_avg <= peak_zxj_avg + 0.5 * peak_zxj_std:
                peak_2_now_zxj_trend = "Down"
            else:
                peak_2_now_zxj_trend = "Up"
                
        peak_2_now_ccl_trend = "Up" if now_ccl_avg > peak_ccl_avg else "Down"
        last_3mins_zxj_trend = self.get_trend_by_std(last_3mins_zxjs, now_zxjs, 0.5)
        last_3mins_ccl_trend = self.get_trend_by_std(last_3mins_ccls, now_ccls, 0.3)
            
        
        start_peak_ccls, start_peak_zxjs = self.get_tick_infos_ccl_and_zxj(tick_infos, start_index, peak_index)
        if len(start_peak_ccls) <= 2:
            return "Unknown", "Unknown"
        past_30_sec_ccls, past_30_sec_zxjs = self.get_tick_infos_ccl_and_zxj(tick_infos, -6, len(tick_infos))
        # Should find the cp rate from balance to balance
        start_peak_cp_rates = statistic_utils.calculate_diff_rate(start_peak_zxjs, start_peak_ccls)
        if len(start_peak_cp_rates) <=2:
            return "Unknown", "Unknown"
        start_peak_cp_rates_avg = mean(start_peak_cp_rates)
        start_peak_cp_rates_std = stdev(start_peak_cp_rates)
        past_30_sec_cp_rates = statistic_utils.calculate_diff_rate(past_30_sec_zxjs, past_30_sec_ccls)
        if len(past_30_sec_cp_rates) <= 2:
            return "Unknown", "Unknown"
        past_30_sec_cp_rates_avg = mean(past_30_sec_cp_rates)
        extra_info = ""    
        # 如果在进行中
        __ccl_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAdjust", "Up", "UpEnd"]
        past_1_min_cjl = sum([tick['cjlDiff'] for tick in tick_infos[-12:] if 'cjlDiff' in tick])
        index_diff = len(tick_infos) - end_index
        last_event_trend = self.get_status_by_ccl_zxj_metric(ccl_trend, zxj_trend)
        current_trend = self.get_status_by_ccl_zxj_metric(last_3mins_ccl_trend, last_3mins_zxj_trend)
        event_status = ""
        if past_1_min_cjl >= self.__hot_cjl_minute_threshold:
            extra_info = "KeepTrend"
        elif past_1_min_cjl >= self.__low_cjl_minute_threshold:
            if index_diff <= 12:                
                # Warming
                event_status = "InEventAndWarm"
                if peak_2_now_zxj_trend == zxj_trend:
                    if start_peak_cp_rates_avg > 0:
                        if past_30_sec_cp_rates_avg < start_peak_cp_rates_avg - start_peak_cp_rates_std:
                            extra_info = "MayTurnover"
                    else:
                        if past_30_sec_cp_rates_avg > start_peak_cp_rates_avg + start_peak_cp_rates_std:
                            extra_info = "MayTurnover"
                else:
                    # current_trend = "UpPullBack" if zxj_trend == "Up" else "DownPullBack"
                    if peak_2_now_ccl_trend == ccl_trend:
                        extra_info = "ZxjCalmDown"
                    else:
                        extra_info = "RegularReverse"
            else:
                # New trend start, Check if trend is same?
                event_status = "OutEventAndWarm"
                if current_trend == last_event_trend:                    
                    extra_info = "StartSameTrend"
                else:
                    # TODO need to add more logic verify
                    extra_info = "PossibleReverse"
                
        else:
            if index_diff <= 12 * 5:
                # Cold
                extra_info = "Ending"
            else:
                extra_info = "Preparing"
                # Stable
        
        #Add event status
        metric['contractTrend'] = current_trend
        metric['lastContractTrend'] = last_event_trend
        metric['extraInfo'] = extra_info
        metric['startTime'] = tick_infos[start_index]['time']
        metric['peakTime'] = tick_infos[peak_index]['time']
        metric['endTime'] = tick_infos[end_index]['time']
        metric['secs'] = index_diff * 5
        metric['ES'] = event_status
        metric['3MinsZxj'] = last_3mins_zxj_trend
        metric['3MinsCcl'] = last_3mins_ccl_trend
        metric['PeakCP'] = round(start_peak_cp_rates_avg,2)
        metric['30SecCP'] = round(past_30_sec_cp_rates_avg,2)
    
    def get_status_by_ccl_zxj_metric(self, ccl_trend, zxj_trend):
        if ccl_trend == "Adjust" or ccl_trend == "Adjust":
            return "Unknown"
        if "Up" in ccl_trend:
            if "Up" in zxj_trend:
                return "Up"
            return "Down"

        if "Down" in zxj_trend:
            return "UpPullBack"
        return "DownPullBack"                
        
    def get_lastest_max_cjl_range(self, tick_infos):
        max_cjl_index = 0
        for i in range(len(tick_infos) - 1, 0, -1):
            sub_ticks = tick_infos[i - 12:i]
            if sum([tick['cjlDiff'] for tick in sub_ticks if 'cjlDiff' in tick]) > self.__hot_cjl_minute_threshold:
                max_cjl_index = i
                break
            i -= 6
        
        if max_cjl_index == 0:
            return 0, 0
        
        # find past hot cjl index
        start_index = 0
        for i in range(max_cjl_index - 1, 0, -1):
            sub_ticks = tick_infos[i - 12:i]
            if sum([tick['cjlDiff'] for tick in sub_ticks if 'cjlDiff' in tick]) < self.__low_cjl_minute_threshold:
                start_index = i
                break
            i -= 6
        
        end_index = max_cjl_index
        for i in range(max_cjl_index, len(tick_infos), 1):
            sub_ticks = tick_infos[i - 12:i]
            if sum([tick['cjlDiff'] for tick in sub_ticks if 'cjlDiff' in tick]) < self.__low_cjl_minute_threshold:
                end_index = i
                break
            i += 6
        
        # 如果成交量异常时间范围太小，就继续往前找
        if end_index - start_index < 12 * 3 and len(tick_infos) > end_index + 12 * 3:
            next_start_index, next_end_index = self.get_lastest_max_cjl_range(tick_infos[:-start_index])
            return next_start_index+start_index, next_end_index+start_index
        return start_index, end_index
        
    def get_tick_infos_ccl_and_zxj(self, tick_infos, start, end):
        ccls = []
        zxjs = []
        for tick in tick_infos[start:end]:
            ccls.append(tick['ccl'])
            zxjs.append(tick['zxj'])
        return ccls, zxjs
    
    def fit_linear_equation(prices, ccls):
        """
        Fit a linear equation y = ax + b using given prices and ccls.

        :param prices: List of prices.
        :param ccls: List of CCLs (in ten thousands).
        :return: Coefficients a and b of the linear equation.
        """
        # Reshape ccls for sklearn LinearRegression
        X = np.array(ccls).reshape(-1, 1)
        y = np.array(prices)

        # Create and fit the model
        model = LinearRegression()
        model.fit(X, y)

        # Coefficients a (slope) and b (intercept)
        a = model.coef_[0]
        b = model.intercept_

        return a, b
            
    def get_cjl_status(self, cjls):
        #    __cjl_status_values = ["Cold", "Warm", "Hot", "StartHot", "Cooling"]
        minutes_cjls = []
        for i in range(0, 12):
            minutes_cjls.append(sum(cjls[i * 6 : (i + 1) * 6]))
        
        if minutes_cjls[-1] >= self.__hot_cjl_minute_threshold /1.7:
            return "Hot"
        elif minutes_cjls[-1] >= self.__low_cjl_minute_threshold /1.7:
            if minutes_cjls[-1] > 1.3 * minutes_cjls[-2]:
                return "StartHot"
            elif minutes_cjls[-1] < 0.7 * minutes_cjls[-2]:
                return "Cooling"
            else:
                return "Warm"
        else:
            return "Cold"

    def is_balance(self, ccls, prices, cjls):

        for i in range(0, 5):
            if sum(cjls[i * 12 : (i + 1) * 12]) > self.__low_cjl_minute_threshold:
                return False        
        
        avg_price = sum(prices) / len(prices)
        min_price = min(prices)
        max_price = max(prices)
        if (max_price - avg_price) / avg_price > self.__balance_avg_to_min_max_price_diff_rate or (avg_price - min_price) / avg_price > self.__balance_avg_to_min_max_price_diff_rate:
            return False   
        
        avg_ccl = sum(ccls) / len(ccls)
        min_ccl = min(ccls)
        max_ccl = max(ccls)
        ccl_day_diff_threshold = avg_ccl * self.__balance_avg_to_min_max_ccl_diff_rate
        if max_ccl - avg_ccl > ccl_day_diff_threshold or avg_ccl - min_ccl > ccl_day_diff_threshold:
            return False
        
        return True

    def get_market_sentiment(self, tick_infos):
        cjl_extremes = self.extremes_set['cjlDiff'][-7:]
        sentiments = []
        for extreme in cjl_extremes:
            index = extreme['index']
            start, end = self.find_hot_period_with_step(tick_infos, index)
            if end - start <= 12:
                continue
            
            ccl_trend = "Up" if tick_infos[end]['ccl'] - tick_infos[start]['ccl'] >= 0.0012 * tick_infos[start]['ccl'] else "Down" if tick_infos[end]['ccl'] - tick_infos[start]['ccl'] < -0.0012 * tick_infos[start]['ccl'] else "Flat"
            zxj_trend = "Up" if tick_infos[index]['zxj'] - tick_infos[start]['zxj'] >= 0.0015 * tick_infos[start]['zxj']  else "Down" if tick_infos[index]['zxj'] - tick_infos[start]['zxj'] =< -0.0015 * tick_infos[start]['zxj'] else "Flat"
            sentiment = {
                'cjlSum': sum([tick['cjlDiff'] for tick in tick_infos[start:end]]),
                'cclTrend': ccl_trend,
                'zxjTrend': zxj_trend                
            }
            sentiments.append(sentiment)
        
            
    def find_hot_period_with_step(self, tick_infos, initial_index, window=6, step=3):
        start_index = initial_index
        end_index = initial_index

        # 向左扩展
        while start_index >= step and self.sum_within_window(tick_infos, start_index - step, window) >= self.__low_cjl_minute_threshold:
            start_index -= step

        # 如果跳出循环后当前点不满足条件，可能需要向右调整至满足条件的点
        while start_index < len(tick_infos) and self.sum_within_window(tick_infos, start_index, window) < self.__low_cjl_minute_threshold:
            start_index += 1

        # 向右扩展
        while end_index + step < len(tick_infos) and self.sum_within_window(tick_infos, end_index + step, window) >= self.__low_cjl_minute_threshold:
            end_index += step

        # 如果跳出循环后当前点不满足条件，可能需要向左调整至满足条件的点
        while end_index >= 0 and self.sum_within_window(tick_infos, end_index, window) < self.__low_cjl_minute_threshold:
            end_index -= 1

        return start_index, end_index

    def sum_within_window(self, tick_infos, index, window=6):
        start = max(index - window, 0)
        end = min(index + window, len(tick_infos) - 1)
        return np.sum([tick['cjlDiff'] for tick in tick_infos[start:end+1]])    
        
    def get_contract_status(self, tick_infos):
        long_count, short_count, long_pullback_count, short_pullback_count = 0, 0, 0, 0
        for i in range(len(extrems) - 2):
            price_diff = extrems[i+1]['zxj'] - extrems[i]['zxj']
            ccl_diff = extrems[i+1]['ccl'] - extrems[i]['ccl']
            if price_diff > 0 and ccl_diff > 0:
                long_count += 1
            elif price_diff < 0 and ccl_diff < 0:
                long_pullback_count += 1
            elif price_diff > 0 and ccl_diff < 0:
                short_pullback_count += 1
            elif price_diff < 0 and ccl_diff > 0:
                short_count += 1
        
        all_count = long_count + short_count
        all_pullback_count = long_pullback_count + short_pullback_count
        count_info = f"{long_count},{short_count},{long_pullback_count},{short_pullback_count}"
        if all_count == 0:
            if long_pullback_count / all_pullback_count > 0.7:
                status = "LongPullback"
            elif short_pullback_count / all_pullback_count > 0.7:
                status = "ShortPullback"
            status = "Unknown"        
        elif long_count / all_count > 0.7:
            status = "Long"
        elif short_count / all_count > 0.7:
            status = "Short"
        else:
            if long_pullback_count / all_pullback_count > 0.7:
                status = "LongPullback"
            elif short_pullback_count / all_pullback_count > 0.7:
                status = "ShortPullback"
            status = "Unknown"
        
        return f"{status},{count_info}"
            
    def find_extremes(self, ticks, span = 45 * 12):
        self.find_peak_start_index = max(self.find_peak_start_index, span)
        for i in range(span, len(ticks) - span):
            # 确定窗口边界
            start = i - span
            end = i + span + 1

            # 当前值
            for col in self.__extreme_cols:
                extremes = self.extremes_set[col]
                current_value = ticks[i][col]
                min_value = min(t[col] for t in ticks[start:end])
                max_value = max(t[col] for t in ticks[start:end])
                # 检查是否为最高或最低值
                if current_value == max_value:
                    extreme = {
                        "extreme": "max",
                        "index": i,
                    }
                    if len(extremes) > 0 and extremes[-1]['extreme'] == 'max' and current_value >= extremes[-1][col]:
                        extremes[-1] = extreme
                    else:
                        extremes.append(extreme)
                elif current_value == min_value:
                    extreme = {
                        "extreme": "min",
                        "index": i,
                    }
                    if len(extremes) > 0 and extremes[-1]['extreme'] == 'min' and current_value <= extremes[-1][col]:
                        extremes[-1] = extreme
                    else:
                        extremes.append(extreme)
                    
        self.find_peak_start_index = len(ticks) - span
        return extremes

if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2023-10-23", "2023-10-27", "rb", "real")
    print(f"ticks count: {len(ticks)}")
    metric_helper = Metric()
    datas = []
    print(f"process number: {len(ticks) - 12*60*6}")
    start_time = time.time()
    for i in range(12 * 60 * 6 - 5, len(ticks)):
        metric = metric_helper.get_current_metrics(ticks[:i])
        data = {
            "time": ticks[i]['time'],
            "code": ticks[i]['code'],
            "zxj": ticks[i]['zxj'],
            "ccl": ticks[i]['ccl'],
            "cjl": ticks[i]['cjlDiff'],
        }
        data.update(metric)
        datas.append(data)
    
    print(f"process time: {round(time.time() - start_time,2)}s")
    utils.convert_dic_to_csv("metrics", datas, is_new=False)
    # def get_current_metrics(self, tick_infos, day_infos):
    #     ccl_status =  self.calculate_ccl_status(tick_infos, day_infos)
    #     ccl_space =  self.calculate_ccl_space(tick_infos, day_infos)
    #     ccl_trend =  self.calculate_ccl_trend(tick_infos, day_infos)
    #     price_status = self.calculate_price_status(tick_infos, day_infos)
    #     price_trend = self.calculate_price_trend(tick_infos, day_infos)
    #     cjl_status = self.calculate_cjl_status(tick_infos, day_infos)
    #     contract_status = self.calculate_contract_status(tick_infos, day_infos)
    #     contract_trend = self.calculate_contract_trend(tick_infos, day_infos)
    #     close_ccl_trend = self.calculate_close_ccl_trend(tick_infos, day_infos)
    #     close_price_trend = self.calculate_close_price_trend(tick_infos, day_infos)
    #     close_price_micro_trend = self.calculate_close_price_micro_trend(tick_infos, day_infos)


    
        
    