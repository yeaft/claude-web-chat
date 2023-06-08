import pandas as pd
from datetime import datetime, timedelta
from collections import deque
from helper import constance, utils, date_utils, analysis_helper, ticks_helper


class RealtimePeakTroughFinder:
    def __init__(self):
        self.candidate_peaks = deque()
        self.candidate_troughs = deque()
        self.confirmed_peaks = []
        self.confirmed_troughs = []
        self.overridden_peaks = []  # 新增：保存被超过的候选波峰
        self.overridden_troughs = []  # 新增：保存被超过的候选波谷
        self.window_size = int(timedelta(hours=2).total_seconds() / 5)

    def process_new_data(self, new_data):
        new_time = pd.to_datetime(new_data["time"])
        new_value = new_data["ccl"]

        # 处理候选的波峰
        while self.candidate_peaks and self.candidate_peaks[0][1] < new_value:
            overridden_peak = self.candidate_peaks.popleft()  # 修改：保存被超过的候选波峰
            self.overridden_peaks.append(overridden_peak)  # 新增
        self.candidate_peaks.append((new_time, new_value))

        if len(self.candidate_peaks) > self.window_size:
            confirmed_peak = self.candidate_peaks.popleft()
            self.confirmed_peaks.append(confirmed_peak)

        # 用类似的方式处理候选的波谷
        while self.candidate_troughs and self.candidate_troughs[0][1] > new_value:
            overridden_trough = self.candidate_troughs.popleft()  # 修改：保存被超过的候选波谷
            self.overridden_troughs.append(overridden_trough)  # 新增
        self.candidate_troughs.append((new_time, new_value))

        if len(self.candidate_troughs) > self.window_size:
            confirmed_trough = self.candidate_troughs.popleft()
            self.confirmed_troughs.append(confirmed_trough)

        return {
            "confirmed_peaks": self.confirmed_peaks,
            "confirmed_troughs": self.confirmed_troughs,
            "candidate_peaks": self.candidate_peaks,
            "candidate_troughs": self.candidate_troughs,
            "overridden_peaks": self.overridden_peaks,  # 新增：返回被超过的候选波峰
            "overridden_troughs": self.overridden_troughs,  # 新增：返回被超过的候选波谷
        }
    
    def get_trends(self):
        # 初始化趋势状态
        overall_trend = "无趋势"
        intra_wave_trend = "无趋势"

        # 如果有足够的确认的波峰和波谷，确定整体趋势
        if len(self.confirmed_peaks) >= 2 and len(self.confirmed_troughs) >= 2:
            # 获取最近的两个确认的波峰和波谷
            last_two_peaks = self.confirmed_peaks[-2:]
            last_two_troughs = self.confirmed_troughs[-2:]

            # 检查波峰和波谷的移动方向
            peak_trend = last_two_peaks[1][1] - last_two_peaks[0][1]
            trough_trend = last_two_troughs[1][1] - last_two_troughs[0][1]

            # 判断整体趋势
            if peak_trend > 0 and trough_trend > 0:
                overall_trend = "上升趋势"
            elif peak_trend < 0 and trough_trend < 0:
                overall_trend = "下降趋势"

        # 如果有最新的候选波峰和候选波谷，确定波内趋势
        if self.candidate_peaks and self.candidate_troughs:
            # 获取最新的数据点时间和价值
            latest_peak_time, latest_peak_value = self.candidate_peaks[-1]
            latest_trough_time, latest_trough_value = self.candidate_troughs[-1]

            # 如果最新的数据点距离现在超过半小时，且当前价值高于最新的候选波谷，认为是波内上升趋势
            if (datetime.now() - latest_peak_time).total_seconds() > timedelta(minutes=30).total_seconds() \
                and latest_peak_value > latest_trough_value:
                intra_wave_trend = "波内上升趋势"
            elif (datetime.now() - latest_trough_time).total_seconds() > timedelta(minutes=30).total_seconds() \
                and latest_peak_value < latest_trough_value:
                intra_wave_trend = "波内下降趋势"

        return overall_trend, intra_wave_trend


if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-11-01", "2022-12-11", "rb", span_type)
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    finder = RealtimePeakTroughFinder()

    for data in ticks:
        finder.process_new_data(data)
