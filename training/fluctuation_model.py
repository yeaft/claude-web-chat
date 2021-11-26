from statistics import mean, variance, stdev

class FLUCTUATION_MODEL:
    def __init__(self, factor, fluctuation_peaks):
        self.factor = factor
        # Some default factors:
        self.peak_past_num = 20
        self.fluctuation_peaks = fluctuation_peaks

    def calculate_related_prices(self, current_contract_info):
        last_peak_index = current_contract_info["lastPeakIndex"]
        consider_peak_start_index = max(1, last_peak_index - 2 * self.peak_past_num - 1)
        sub_peak_infos = self.fluctuation_peaks[current_contract_info["code"]][self.factor["fluctuation"]][consider_peak_start_index: last_peak_index+1]
        rate = 1
        if self.open_direction == "up":
            sub_peaks = list(x['diffPer'] for x in sub_peak_infos if x['diffPer'] > 0)
        else:
            sub_peaks = list(x['diffPer'] for x in sub_peak_infos if x['diffPer'] < 0)
            rate = -1

        avg_sub_peaks = abs(mean(sub_peaks))
        stdev_sub_peaks = stdev(sub_peaks)
        trigger_diff = avg_sub_peaks + self.factor["triggerStdevRate"] * stdev_sub_peaks
        win_diff = (avg_sub_peaks + self.factor["peakStdevWinRate"] * stdev_sub_peaks) * rate
        extra_open_diff = (avg_sub_peaks + self.factor["peakStdevExtraOpenRate"] * stdev_sub_peaks) * rate
        cut_diff = (avg_sub_peaks + self.factor["peakStdevCutRate"] * stdev_sub_peaks) * rate * -1

        return trigger_diff

    def open(self, open_type, current_contract_info):
        return True

    def cut(self, cut_type, current_contract_info):
        return True
    
    def generate_factors(self):
        factors = []
        for fluctuation in [0.007, 0.0075, 0.008, 0.0085, 0.0095]:
            for trigger_stdev_rate in [2.5, 3, 4, 5]:
                for max_hold_num in [1, 3]:
                    for start_cut_peak_diff in [3, 5]:
                        for must_cut_fluctuation_rate in [0.5, 1, 2]:
                            for peak_stdev_extra_open_rate in [2, 3, 4]:
                                # for peak_diff_rate in [0.5, 1, 2]:
                                for peak_stdev_win_rate in [3, 4]:
                                    for peak_stdev_cut_rate in [1, 2]:
                                        for min_ccl_diff in [0]:
                                            factor = {
                                                "fluctuation": fluctuation,
                                                "triggerStdevRate": trigger_stdev_rate,
                                                "maxHoldNum": max_hold_num,
                                                "startCutPeakDiff": start_cut_peak_diff,
                                                "mustCutFluctuationRate": must_cut_fluctuation_rate,
                                                "peakStdevExtraOpenRate": peak_stdev_extra_open_rate,
                                                "peakStdevWinRate": peak_stdev_win_rate,
                                                "peakStdevCutRate": peak_stdev_cut_rate,
                                                "minCCLDiff": min_ccl_diff
                                            }
                                            factors.append(factor)
        return factors

    def factor_to_str(self, factor):
        return "{},{},{},{},{},{},{},{},{}".format(factor["fluctuation"], factor["triggerStdevRate"], factor["maxHoldNum"], factor["startCutPeakDiff"], factor["mustCutFluctuationRate"],
                                                   factor["extraOpenRate"], factor["peakStdevWinRate"], factor["peakStdevCutRate"], factor["minCCLDiff"])
    
    def factor_str_to_obj(self, factor_str):
        factor_arr = factor_str.split(",")
        factor = {
            "fluctuation": factor_arr[0],
            "triggerStdevRate": factor_arr[1],
            "maxHoldNum": factor_arr[2],
            "startCutPeakDiff": factor_arr[3],
            "mustCutFluctuationRate": factor_arr[4],
            "peakStdevExtraOpenRate": factor_arr[5],
            "peakStdevWinRate": factor_arr[6],
            "peakStdevCutRate": factor_arr[7],
            "minCCLDiff": factor_arr[8]
        }
        return factor
