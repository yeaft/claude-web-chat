import numpy as np
from sklearn.linear_model import LinearRegression
from statistics import mean, variance, stdev

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


    def __init__(self):
        self.ccl_status = None
        self.ccl_space = None # transfer to money
        self.ccl_trend = None



    def calculate_ccl_status(self, tick_infos, day_infos):
        pass

    def calculate_ccl_space(self, tick_infos, day_infos):
        pass

    def calculate_ccl_trend(self, tick_infos, day_infos):
        pass

    def calculate_price_status(self, tick_infos, day_infos):
        pass

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
    
    def get_current_metrics(self, tick_infos, day_infos):        
        metric = {}
        if len(tick_infos) < self.__six_hours_check_point_count:
            return 

        # 确定大方向
        contract_status = self.get_contract_status(tick_infos)
        metric['contractStatus'] = contract_status
        
        past_five_mins_ticks = tick_infos[-self.__five_minute_check_point_count:]
        cjls = [tick['cjlDiff'] for tick in past_five_mins_ticks]
        metric['cjlStatus'] = self.get_cjl_status(cjls)

        prices = [tick['zxj'] for tick in past_five_mins_ticks]
        metric['zxjTrend'] = self.get_trend(prices, 9, 12 * 5, self.__balance_avg_to_min_max_price_diff_rate)
        
        ccls = [tick['ccl'] for tick in past_five_mins_ticks]
        metric['cclTrend'] = self.get_trend(ccls, 9, 12 * 5, self.__balance_avg_to_min_max_ccl_diff_rate)
        
        if metric['cjlStatus'] == "Cold" and self.is_balance(ccls, prices, cjls):
            metric['contractTrend'] = "Balance"
    
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
    
    def get_event_trend(self, tick_infos):
        # cjl abnormal range, ccl peak, price peak
        # 先找到最近的一个cjl异常点，并得到大量成交范围，确定方向
        # 成交范围前可能就是平衡态
        start_index, end_index = self.get_lastest_max_cjl_range(tick_infos)
        if end_index - start_index < 12:
            return
        
        sub_ticks = tick_infos[start_index:end_index]
        max_cjl_tick = max(sub_ticks, key=lambda x: x['cjlDiff'])
        if max_cjl_tick['zxj'] > tick_infos[start_index]['zxj']:
            price_trend = "Up"
            max_zxj = max(sub_ticks, key=lambda x: x['zxj'])
            for i in range(tick_infos[start_index:end_index]):
                if tick_infos[i]['zxj'] == max_zxj:
                    peak_index = i
                    break
        else:
            price_trend = "Down"
            min_zxj = min(sub_ticks, key=lambda x: x['zxj'])
            for i in range(tick_infos[start_index:end_index]):
                if tick_infos[i]['zxj'] == min_zxj:
                    peak_index = i
                    break
        
        start_sub = tick_infos[start_index-6:start_index+6]
        peak_sub = tick_infos[peak_index-6: peak_index+6]
        end_sub = tick_infos[end_index-6: end_index+6]
        now_sub = tick_infos[-6:]
        start_ccl_avg = mean([t['ccl'] for t in start_sub])
        peak_ccl_avg = mean([t['ccl'] for t in peak_sub])
        end_ccl_avg = mean([t['ccl'] for t in end_sub])
        now_ccl_avg = mean([t['ccl'] for t in now_sub])
        peak_zxj_avg = mean([t['zxj'] for t in peak_sub])
        now_zxj_avg = mean([t['zxj'] for t in now_sub])
        end_zxj_avg = mean([t['zxj'] for t in end_sub])
        
        if peak_ccl_avg > start_ccl_avg:
            ccl_trend = "Up"
        else:
            ccl_trend = "Down"
        
        now_zxj_trend = "Up" if now_zxj_avg > peak_zxj_avg else "Down"
        # TODO use pc rate，peak past 1min avg vs now past 1min avg
        now_ccl_trend = "Up" if now_ccl_avg > peak_ccl_avg else "Down"
                
        # 如果在进行中
        __ccl_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAdjust", "Up", "UpEnd"]
        past_1_min_cjl = sum([tick['cjlDiff'] for tick in tick_infos[-12:]])
        index_diff = len(tick_infos) - end_index
        last_event_trend = self.get_status_by_ccl_zxj_metric(ccl_trend, price_trend)
        if past_1_min_cjl > self.__hot_cjl_minute_threshold:
            if index_diff <= 12:
                # Hot, Keep status
                contract_trend = last_event_trend
            else:
                contract_trend = "Error"
        elif past_1_min_cjl > self.__low_cjl_minute_threshold:
            if index_diff <= 12:                
                # Warming
                
                
                    
                contract_trend = "UpPullBack" if price_trend == "Up" else "DownPullBack"1
            else:
                # New trend start, Check if trend is same?
                zxj_sub = [tick['zxj'] for tick in tick_infos[-12*5:]]
                contract_trend = self.get_trend(zxj_sub, 6, 12 * 3).replaceAll("Fast", "")
                
        elif past_1_min_cjl < self.__low_cjl_minute_threshold:
            if index_diff <= 12:
                # Cold
                
            elif index_diff <= 12 * 5:
                # Posible reverse
            else:
                # Stable
        
        # 刚进行完
        # 早已进行完
    
        
        pass
    
    def get_status_by_ccl_zxj_metric(self, ccl_trend, zxj_trend):
        if ccl_trend == "Up":
            if zxj_trend == "Up":
                return "Up"
            return "Down"

        if zxj_trend == "Down":
            return "UpPullBack"
        return "DownPullBack"                
        
    def get_lastest_max_cjl_range(self, tick_infos):
        max_cjl_index = 0
        for i in range(len(tick_infos) - 1, 0, -1):
            sub_ticks = tick_infos[i - 12:i]
            if sum([tick['cjlDiff'] for tick in sub_ticks]) > self.__hot_cjl_minute_threshold:
                max_cjl_index = i
                break
            i -= 6
        
        if max_cjl_index == 0:
            return 0, 0
        
        # find past hot cjl index
        start_index = 0
        for i in range(max_cjl_index - 1, 0, -1):
            sub_ticks = tick_infos[i - 12:i]
            if sum([tick['cjlDiff'] for tick in sub_ticks]) < self.__low_cjl_minute_threshold:
                start_index = i
                break
            i -= 6
        
        end_index = max_cjl_index
        for i in range(max_cjl_index, len(tick_infos), 1):
            sub_ticks = tick_infos[i - 12:i]
            if sum([tick['cjlDiff'] for tick in sub_ticks]) < self.__low_cjl_minute_threshold:
                end_index = i
                break
            i += 6
        
        # 如果成交量异常时间范围太小，就继续往前找
        if end_index - start_index < 12 * 3 and len(tick_infos) > end_index + 12 * 3:
            next_start_index, next_end_index = self.get_lastest_max_cjl_range(tick_infos[:-start_index])
            return next_start_index+start_index, next_end_index+start_index
        return start_index, end_index
    
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
        for i in range(0, 5):
            minutes_cjls.append(sum(cjls[i * 12 : (i + 1) * 12]))
        
        if minutes_cjls[-1] >= self.__hot_cjl_minute_threshold:
            return "Hot"
        elif minutes_cjls[-1] >= self.__low_cjl_minute_threshold:
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

    def get_contract_status(self, tick_infos):
        extrems = self.find_extremes(tick_infos[-self.__six_hours_check_point_count:])
        if len(extrems) < 2:
            return None

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
        extremes = []  # 用于存储最高和最低值的索
        for i in range(span, len(ticks) - span - 1):
            # 确定窗口边界
            start = i - span
            end = i + span + 1

            # 当前值
            current_value = ticks[i]['zxj']
            min_value = min(t['zxj'] for t in ticks[start:end])
            max_value = max(t['zxj'] for t in ticks[start:end])
            # 检查是否为最高或最低值
            if current_value == max_value:
                ticks[i]['extreme'] = 'max'
                if len(extremes) > 0 and extremes[-1]['extreme'] == 'max' and current_value >= extremes[-1]['zxj']:
                    extremes[-1] = ticks[i]
                else:
                    extremes.append(ticks[i])
            elif current_value == min_value:
                ticks[i]['extreme'] = 'min'
                if len(extremes) > 0 and extremes[-1]['extreme'] == 'min' and current_value <= extremes[-1]['zxj']:
                    extremes[-1] = ticks[i]
                else:
                    extremes.append(ticks[i])

        return extremes

    def calculate_close_ccl_trend(self, tick_infos, day_infos):
        pass

    def calculate_close_price_trend(self, tick_infos, day_infos):
        pass

    def calculate_close_price_micro_trend(self, tick_infos, day_infos):
        pass

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


    
        
    