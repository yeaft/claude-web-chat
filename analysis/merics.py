class Metric:
    # Lowest means today is has the lowest value in the last 10 days, and current is not higher than 10% of daily waves
    # Highest is similar
    __ccl_status_values = ["Lowest", "Low", "Normal", "High", "Highest"]
    __ccl_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAdjust", "Up", "UpEnd"]
    __price_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAjust", "Up", "UpEnd"]
    __price_micro_trend_values = ["Down", "Adjust", "Up"]
    __contract_status_values = ["ShortToLong", "Long", "LongToShort", "Short", "Hold"]
    __contract_micro_status_values = ["Long", "Short", "Hold"]
    __close_ccl_trend_values = ["Down", "Adjust", "Up"]
    __close_price_trend_values = ["Down", "Adjust", "Up"]


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
        pass

    def calculate_price_micro_trend(self, tick_infos, day_infos):
        pass

    def calculate_contract_status(self, tick_infos, day_infos):
        pass

    def calculate_contract_micro_status(self, tick_infos, day_infos):
        pass

    def calculate_close_ccl_trend(self, tick_infos, day_infos):
        pass

    def calculate_close_price_trend(self, tick_infos, day_infos):
        pass

    def calculate_close_price_micro_trend(self, tick_infos, day_infos):
        pass

    def get_current_metrics(self, tick_infos, day_infos):
        ccl_status =  self.calculate_ccl_status(tick_infos, day_infos)
        ccl_space =  self.calculate_ccl_space(tick_infos, day_infos)
        ccl_trend =  self.calculate_ccl_trend(tick_infos, day_infos)
        price_status = self.calculate_price_status(tick_infos, day_infos)
        price_trend = self.calculate_price_trend(tick_infos, day_infos)
        price_micro_trend = self.calculate_price_micro_trend(tick_infos, day_infos)
        contract_status = self.calculate_contract_status(tick_infos, day_infos)
        contract_micro_status = self.calculate_contract_micro_status(tick_infos, day_infos)
        close_ccl_trend = self.calculate_close_ccl_trend(tick_infos, day_infos)
        close_price_trend = self.calculate_close_price_trend(tick_infos, day_infos)
        close_price_micro_trend = self.calculate_close_price_micro_trend(tick_infos, day_infos)


    # 短时间可以解释长时间的情况，但是长时间并不能解释短时间或者是未来的情况，长时间是所有短时间的汇总结果，但是不知道当前是在那个真实的状态
    # 状态不是由时间构成的，而是由事件构成的，所以考虑状态时，应该看发生了什么哪些事件，哪些事件占主导地位，哪些事件是次要的。而不是用时间片段组成。
    # 持仓量增减与价格变化出现的是客观事实。但是它是否占主导，则是认为的定性利于分析。比如上涨回调就是定性，客观就是下跌。
        
        
    