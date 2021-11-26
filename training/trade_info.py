class TRADE_INFO:
    def __init__(self):
        self.initial_data()        
    
    def initial_data(self):
        self.direction = ""
        self.open_price = 0
        self.close_price = 0
        self.trigger_time = ""
        self.close_time = ""
        self.cut_peak_time = ""
        self.cut_peak_price = ''
        self.cut_peak_index = 0
        self.hold_peak_num = 0
        self.open_time_history = []
        self.open_price_history = []
        self.close_price_history = []
        self.close_time_history = []
        self.hold_position_count = 0
        self.result_price_per = 0
        self.result_real_per = 0
        self.result_mean_per = 0
