class trend_context:
    def __init__(self, trend_min_diff_rate = 0.05):
        self.context = {
            "status": "unknown",
            "last_peak_price": 0,
            "last_peak_time": "",
            "last_peak_type": "unknown",
            "trend_min_diff_rate": trend_min_diff_rate
        }