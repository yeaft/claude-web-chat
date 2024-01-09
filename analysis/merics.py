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
    
    __low_cjl_minute_threshold = 2000
    __hot_cjl_minute_threshold = 6000
    __five_minute_check_point_count = 5 * 12
    __six_hours_check_point_count = 6 * 60 * 12
    __balance_avg_to_min_max_price_diff_rate = 0.0008
    __balance_avg_to_min_max_ccl_diff = 100

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

        extrems = self.find_extremes(tick_infos[-self.__six_hours_check_point_count:])
        # 确定大方向
        contract_status = self.get_contract_status(tick_infos, extrems)
        metric['contractStatus'] = contract_status
        
        past_five_mins_ticks = tick_infos[-self.__five_minute_check_point_count:]
        cjls = [tick['cjlDiff'] for tick in past_five_mins_ticks]
        metric['cjlStatus'] = self.get_cjl_status(cjls)

        prices = [tick['zxj'] for tick in past_five_mins_ticks]
        ccls = [tick['ccl'] for tick in past_five_mins_ticks]
        if metric['cjlStatus'] == "Cold" and self.is_balance(ccls, prices, cjls):
            metric['contractTrend'] = "Balance"
    
    def get_zxj_trend(self, prices):
        
        
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
        if max_ccl - avg_ccl > self.__balance_avg_to_min_max_ccl_diff or avg_ccl - min_ccl > self.__balance_avg_to_min_max_ccl_diff:
            return False
        
        return True

    def get_contract_status(self, tick_infos, extrems):
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
        for i in range(len(ticks)):
            # 确定窗口边界
            start = max(0, i - span)
            end = min(len(ticks), i + span + 1)

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


    
        
    