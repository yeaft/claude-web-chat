import pandas as pd
from helper import constance, utils, date_utils, analysis_helper, ticks_helper
from collections import deque
from datetime import datetime, timedelta
import numpy as np
import pytz
import random
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import mplcursors

class AnomalyDetector:
    def __init__(self, cjl_period_min_threshold = 5800, cjl_period_pass_threshold=8000,  past_num=60, period_num=3):
        self.datas = []
        self.anomalies = []
        self.cjl_period_min_threshold = cjl_period_min_threshold
        self.cjl_period_pass_threshold = cjl_period_pass_threshold
        self.past_num = past_num
        self.period_num = period_num
    
    def print_anomalies(self):
        print(f'Anomalies: {len(self.anomalies)}')
        for anomaly in self.anomalies:
            print(f'{anomaly["code"]} {anomaly["time"]} {anomaly["cjl"]} {anomaly["zxj"]}')

    def process_new_data(self, data):
        self.datas.append(data)

        # Parse time
        data['time'] = datetime.strptime(
            data['time'], '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=pytz.UTC)
        data['anomaly'] = False
        
        if len(self.datas) > self.past_num + self.period_num:
            past_cjl = [d['cjl'] for d in self.datas[-self.past_num-self.period_num:-self.period_num]]
            past_cjl_mean = np.mean(past_cjl)
            past_cjl_std = np.std(past_cjl)
            last_period_cjl_sum = sum([d['cjl'] for d in self.datas[-self.period_num:]])
            last_period_cjl = int(last_period_cjl_sum / self.period_num)
            if (last_period_cjl - past_cjl_mean > 5 * past_cjl_std and last_period_cjl_sum > self.cjl_period_min_threshold) or last_period_cjl_sum > self.cjl_period_pass_threshold:
                data['anomaly'] = True
                self.anomalies.append(data)        

def draw_abnormal(ad, resample_rule='30S'):
    print(f'Anomalies: {len(ad.anomalies)}')
    df = pd.DataFrame(ad.datas)
    df.set_index('time', inplace=True)
    df.index = pd.to_datetime(df.index)
    df.drop(df[df['cjl'] == 0].index, inplace=True)

    # Resampling the data
    df_resampled = df.resample(resample_rule).agg({'cjl': 'sum', 'anomaly': 'any'})

    # Creating the color list
    colors = ['red' if anomaly else 'blue' for anomaly in df_resampled['anomaly']]

    # Using integer sequence for x-axis to ensure bars are continuous
    x = range(len(df_resampled))

    # Create the plot
    fig, ax = plt.subplots(figsize=(12, 6))

    # We use a width slightly less than 1 for the bars to ensure there's a small gap between them
    ax.bar(x, df_resampled['cjl'], color=colors, width=0.8)

    # Set custom ticks to show the dates
    ax.set_xticks(x[::int(len(x)/10)])  # Showing only every 10th date for clarity
    ax.set_xticklabels(df_resampled.index[::int(len(x)/10)].strftime('%Y-%m-%d %H:%M:%S'), rotation=45)

    ax.set_ylabel('CJL')
    ax.set_title(f'CJL over Time Resampled every {resample_rule} with Anomalies Highlighted in Red')

    # Add mplcursors for interactive data
    mplcursors.cursor(hover=True)

    plt.tight_layout()  # Ensure everything fits without overlap
    plt.show()




if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-11-01", "2022-11-05", "rb", span_type)
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    ad = AnomalyDetector()
    for tick in ticks:
        ad.process_new_data(tick)
    
    ad.print_anomalies()
    utils.convert_dic_to_csv("anomalies_v2", ad.datas)
    
    draw_abnormal(ad)

