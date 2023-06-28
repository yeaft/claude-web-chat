import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from scipy import stats


class WaveAnalyzer:
    def __init__(self):
        # 初始化变量
        self.candidate_peaks = []  # 候选波峰
        self.candidate_troughs = []  # 候选波谷
        self.confirmed_peaks = []  # 确定的波峰
        self.confirmed_troughs = []  # 确定的波谷
        self.pairs = []  # 波峰和波谷的配对

    def update(self, new_data):
        # 更新数据
        self.update_candidates(new_data)
        self.confirm_peaks_and_troughs()
        self.filter_invalid_waves()
        self.get_pairs()

    def update_candidates(self, new_data):
        # 更新候选波峰和波谷
        # latest_data是最新的数据，它包含了当前的时间和价值（交易量）
        latest_data = new_data.iloc[-1]
        current_time = latest_data.name
        current_value = latest_data['volume']

        # 更新候选波峰
        self.update_peak_candidates(current_time, current_value)

        # 更新候选波谷
        self.update_trough_candidates(current_time, current_value)

    def update_peak_candidates(self, current_time, current_value):
        # 如果有足够的候选波峰，对它们进行比较和更新
        if len(self.candidate_peaks) >= 2:
            # 获取最后两个候选波峰的时间和价值
            last_peak_time, last_peak_value = self.candidate_peaks[-1]
            second_last_peak_time, second_last_peak_value = self.candidate_peaks[-2]

            # 比较候选波峰和当前价值，更新候选波峰
            if last_peak_value > second_last_peak_value:
                if current_value < last_peak_value:
                    self.candidate_peaks[-1] = (current_time, current_value)
            else:
                if current_value > second_last_peak_value:
                    self.candidate_peaks[-2] = (current_time, current_value)
                elif current_value < last_peak_value:
                    self.candidate_peaks[-1] = (current_time, current_value)

    def update_trough_candidates(self, current_time, current_value):
        # 如果有足够的候选波谷，对它们进行比较和更新
        if len(self.candidate_troughs) >= 2:
            # 获取最后两个候选波谷的时间和价值
            last_trough_time, last_trough_value = self.candidate_troughs[-1]
            second_last_trough_time, second_last_trough_value = self.candidate_troughs[-2]

            # 比较候选波谷和当前价值，更新候选波谷
            if last_trough_value < second_last_trough_value:
                if current_value > last_trough_value:
                    self.candidate_troughs[-1] = (current_time, current_value)
            else:
                if current_value < second_last_trough_value:
                    self.candidate_troughs[-2] = (current_time, current_value)
                elif current_value > last_trough_value:
                    self.candidate_troughs[-1] = (current_time, current_value)

    def confirm_peaks_and_troughs(self):
        # 确定波峰和波谷
        if len(self.candidate_peaks) >= 2 and len(self.candidate_troughs) >= 2:
            # 获取最后的候选波峰和候选波谷
            latest_peak_time, latest_peak_value = self.candidate_peaks[-1]
            latest_trough_time, latest_trough_value = self.candidate_troughs[-1]

            # 如果最后的候选波峰早于最后的候选波谷，且其价值高于最后的候选波谷，确认最后的候选波峰
            if latest_peak_time < latest_trough_time and latest_peak_value > latest_trough_value:
                self.confirmed_peaks.append(self.candidate_peaks.pop(-1))

            # 如果最后的候选波谷早于最后的候选波峰，且其价值低于最后的候选波峰，确认最后的候选波谷
            elif latest_trough_time < latest_peak_time and latest_trough_value < latest_peak_value:
                self.confirmed_troughs.append(self.candidate_troughs.pop(-1))

    def filter_invalid_waves(self):
        # 滤除无效的波动
        if len(self.confirmed_peaks) >= 2 and len(self.confirmed_troughs) >= 2:
            # 获取最近的两个确认的波峰和波谷
            latest_peak_time, latest_peak_value = self.confirmed_peaks[-1]
            second_latest_peak_time, second_latest_peak_value = self.confirmed_peaks[-2]
            latest_trough_time, latest_trough_value = self.confirmed_troughs[-1]
            second_latest_trough_time, second_latest_trough_value = self.confirmed_troughs[-2]

            # 如果最新的波峰是在最新的波谷之后，比较它与上一个波峰的价值，选择价值更高的一个
            if latest_peak_time > latest_trough_time:
                if latest_peak_value <= second_latest_peak_value:
                    self.confirmed_peaks.pop(-1)
                else:
                    self.confirmed_peaks.pop(-2)

            # 如果最新的波谷是在最新的波峰之后，比较它与上一个波谷的价值，选择价值更低的一个
            else:
                if latest_trough_value >= second_latest_trough_value:
                    self.confirmed_troughs.pop(-1)
                else:
                    self.confirmed_troughs.pop(-2)

    def get_pairs(self):
        # 更新波峰和波谷的配对
        self.pairs = [(peak, trough) for peak, trough in zip(
            self.confirmed_peaks, self.confirmed_troughs)]

    def get_segments(self):
        # 获取每个上升段和下降段
        segments = []
        for i in range(len(self.confirmed_peaks)-1):
            if self.confirmed_peaks[i][0] < self.confirmed_troughs[i][0] and self.confirmed_peaks[i+1][0] > self.confirmed_troughs[i][0]:
                segments.append(
                    ('increase', self.confirmed_peaks[i][0], self.confirmed_peaks[i+1][0]))
            else:
                segments.append(
                    ('decrease', self.confirmed_peaks[i][0], self.confirmed_troughs[i+1][0]))
        return segments


def get_price_trend_during_volume_change(df, segments):
    # 计算在每个交易量变化阶段的价格趋势
    trends = []
    for segment in segments:
        direction, start_time, end_time = segment
        segment_df = df.loc[start_time:end_time]
        slope, intercept, r_value, p_value, std_err = stats.linregress(
            range(len(segment_df)), segment_df['price'])
        if slope > 0:
            trends.append(('increase', slope))
        else:
            trends.append(('decrease', slope))
    return trends


def get_overall_trend(df, segments, N):
    # 获取N个连续阶段的总体价格趋势
    if len(segments) < N:
        return None
    else:
        trends = get_price_trend_during_volume_change(df, segments[-N:])
        increase_trends = [trend for trend in trends if trend[0] == 'increase']
        decrease_trends = [trend for trend in trends if trend[0] == 'decrease']
        return len(increase_trends), np.mean([trend[1] for trend in increase_trends]), len(decrease_trends), np.mean([trend[1] for trend in decrease_trends])
