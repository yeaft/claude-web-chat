class Metric:
    # Lowest means today is has the lowest value in the last 10 days, and current is not higher than 10% of daily waves
    # Highest is similar
    __ccl_status_values = ["Lowest", "Low", "Normal", "High", "Highest"]
    __ccl_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAdjust", "Up", "UpEnd"]
    __price_trend_values = ["DownEnd", "Down", "UpAdjust", "Adjust", "DownAjust", "Up", "UpEnd"]
    __price_micro_trend_values = ["Down", "Adjust", "Up"]
    __cjl_status_values = ["Lowest", "Low", "Normal", "High", "Highest"]
    __contract_status_values = ["ShortToLong", "Long", "LongToShort", "Short", "Balance"]
    __contract_trend_values = ["Long", "Short", "Balance"]
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
        # 1. 绝对定义：时间范围内的价格和ccl稳定，且cjl很低
        # 2. 参考率: 单位ccl的价格变化
        pass

    def calculate_cjl_status(self, tick_infos, day_infos):
        pass

    def calculate_contract_status(self, tick_infos, day_infos):
        pass

    def calculate_contract_trend(self, tick_infos, day_infos):
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
        cjl_status = self.calculate_cjl_status(tick_infos, day_infos)
        contract_status = self.calculate_contract_status(tick_infos, day_infos)
        contract_trend = self.calculate_contract_trend(tick_infos, day_infos)
        close_ccl_trend = self.calculate_close_ccl_trend(tick_infos, day_infos)
        close_price_trend = self.calculate_close_price_trend(tick_infos, day_infos)
        close_price_micro_trend = self.calculate_close_price_micro_trend(tick_infos, day_infos)


    
        
    