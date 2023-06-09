from helper import constance, utils, date_utils, analysis_helper, ticks_helper
from collections import deque
import pandas as pd
import numpy as np
from datetime import datetime, timedelta


class RealtimePeakTroughFinder:
    def __init__(self):
        self.candidate_peaks = deque()
        self.candidate_troughs = deque()
        self.confirmed_peaks = []
        self.confirmed_troughs = []
        self.overridden_peaks = []
        self.overridden_troughs = []
        self.slope_thresholds_peaks = []
        self.slope_thresholds_troughs = []
        self.window_size = int(timedelta(hours=2).total_seconds() / 5)

    def process_new_data(self, new_data):
            # 初始化新数据
        new_time = pd.to_datetime(new_data["time"])
        new_value = new_data["ccl"]

        # 处理候选波峰
        while self.candidate_peaks and self.candidate_peaks[0][1] < new_value:
            overridden_peak = self.candidate_peaks.popleft()
            self.overridden_peaks.append(overridden_peak)
        self.candidate_peaks.append((new_time, new_value))

        # 如果有足够的数据，并且最后一个确认的点不是波峰，确认新的波峰
        if len(self.candidate_peaks) > self.window_size and (not self.confirmed_peaks or self.confirmed_peaks[-1][0] < self.confirmed_troughs[-1][0]):
            confirmed_peak = self.candidate_peaks.popleft()
            self.confirmed_peaks.append(confirmed_peak)

        # 检查并处理连续的波峰
        if len(self.confirmed_peaks) > 1 and self.confirmed_peaks[-1][0] < self.confirmed_troughs[-1][0]:
            if self.confirmed_peaks[-1][1] > self.confirmed_peaks[-2][1]:
                overridden_peak = self.confirmed_peaks.pop(-2)
            else:
                overridden_peak = self.confirmed_peaks.pop(-1)
            self.overridden_peaks.append(overridden_peak)

        # 类似地，处理候选波谷
        while self.candidate_troughs and self.candidate_troughs[0][1] > new_value:
            overridden_trough = self.candidate_troughs.popleft()
            self.overridden_troughs.append(overridden_trough)
        self.candidate_troughs.append((new_time, new_value))

        # 如果有足够的数据，并且最后一个确认的点不是波谷，确认新的波谷
        if len(self.candidate_troughs) > self.window_size and (not self.confirmed_troughs or self.confirmed_troughs[-1][0] < self.confirmed_peaks[-1][0]):
            confirmed_trough = self.candidate_troughs.popleft()
            self.confirmed_troughs.append(confirmed_trough)

        # 检查并处理连续的波谷
        if len(self.confirmed_troughs) > 1 and self.confirmed_troughs[-1][0] < self.confirmed_peaks[-1][0]:
            if self.confirmed_troughs[-1][1] < self.confirmed_troughs[-2][1]:
                overridden_trough = self.confirmed_troughs.pop(-2)
            else:
                overridden_trough = self.confirmed_troughs.pop(-1)
            self.overridden_troughs.append(overridden_trough)

    def calculate_thresholds(self, volume_series):
        for confirmed_peak in self.confirmed_peaks[-5:]:
            window_start = confirmed_peak[0] - timedelta(minutes=30)
            window_end = confirmed_peak[0] + timedelta(minutes=30)
            volume_max_loc = volume_series.loc[window_start:window_end].idxmax(
            )
            slope = (confirmed_peak[1] - volume_series.loc[volume_max_loc]) / \
                ((confirmed_peak[0] - volume_max_loc).total_seconds() / 60)
            self.slope_thresholds_peaks.append(slope)

        for confirmed_trough in self.confirmed_troughs[-5:]:
            window_start = confirmed_trough[0] - timedelta(minutes=30)
            window_end = confirmed_trough[0] + timedelta(minutes=30)
            volume_max_loc = volume_series.loc[window_start:window_end].idxmax(
            )
            slope = (confirmed_trough[1] - volume_series.loc[volume_max_loc]) / (
                (confirmed_trough[0] - volume_max_loc).total_seconds() / 60)
            self.slope_thresholds_troughs.append(slope)

        return {
            "slope_thresholds_peaks": self.slope_thresholds_peaks,
            "slope_thresholds_troughs": self.slope_thresholds_troughs,
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
            if peak_trend > np.mean(self.slope_thresholds_peaks) and trough_trend > np.mean(self.slope_thresholds_troughs):
                overall_trend = "上升趋势"
            elif peak_trend < -np.mean(self.slope_thresholds_peaks) and trough_trend < -np.mean(self.slope_thresholds_troughs):
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
