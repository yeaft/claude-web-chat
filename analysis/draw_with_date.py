from scipy.signal import find_peaks
from datetime import datetime
from helper import constance, utils, date_utils, analysis_helper
from matplotlib.animation import FuncAnimation
from statistics import mean, variance, stdev

import numpy as np
import matplotlib.pyplot as plt
from scipy.fftpack import fft

import matplotlib.pyplot as plt
from matplotlib.widgets import Cursor
import pandas as pd
import numpy as np


class Cursor(object):
    def __init__(self, ax, dates):
        self.ax = ax
        self.lx = ax.axhline(color='k')  # the horiz line
        self.ly = ax.axvline(color='k')  # the vert line

        # text location in axes coords
        self.txt = ax.text(0.7, 0.9, '', transform=ax.transAxes)
        self.dates = dates
        self.date_format = '%Y-%m-%d %H:%M:%S'

    def mouse_move(self, event):
        if not event.inaxes:
            return

        x, y = event.xdata, event.ydata
        self.lx.set_ydata(y)
        self.ly.set_xdata(x)
        self.txt.set_text('x=%s, y=%s' % (x, y))

        # 在竖线上添加日期
        if x in self.dates.values:
            index = np.where(self.dates == x)[0][0]
            date_str = self.dates[index].strftime(self.date_format)
            self.txt.set_text('x=%s, y=%s, date=%s' % (x, y, date_str))

        self.ax.figure.canvas.draw()

def draw_data(ticks):
    price_arr, volume_arr, times_arr = [], [], []
    for x in ticks:
        price_arr.append(x['zxj'])
        volume_arr.append(x['sum_ccl'])
        times_arr.append(pd.to_datetime(x['time']))

    dates = np.array(times_arr)
    volume = np.array(volume_arr)
    price = np.array(price_arr)

    # # 读取数据
    # df = pd.read_csv('data.csv')
    # df['datetime'] = pd.to_datetime(df['datetime'])

    # 定义两个子图的y轴范围
    ylim1 = (price.min() * 0.99, price.max() * 1.01)
    ylim2 = (volume.min() * 0.99, volume.max() * 1.01)

    # 创建子图
    fig, ax1 = plt.subplots()
    ax2 = ax1.twinx()

    # 画最新价和持仓量曲线
    ax1.plot(dates, price, color='blue', label='Last Price')
    ax2.plot(dates, volume, color='red', label='Position')

    # 设置x轴的格式
    date_format = '%Y-%m-%d %H:%M:%S'
    plt.gcf().autofmt_xdate()
    # plt.gca().xaxis.set_major_formatter(
    #     plt.FixedFormatter(dates. strftime(date_format)))

    # 添加图例
    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    lines = lines1 + lines2
    labels = labels1 + labels2
    plt.legend(lines, labels, loc='upper left')

    # 定义Cursor类并实例化
    cursor = Cursor(ax1, dates)
    plt.connect('motion_notify_event', cursor.mouse_move)

    plt.show()


def prepare_ticks(contract_type, start_date, end_date):
    # five_sec_main_col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(
    #     contract_type)]
    five_sec_main_col = constance.FUTURE_DB['tick_{}_main_1_min'.format(
        contract_type)]
    ticks = five_sec_main_col.find(
        {"date": {"$gte": start_date, "$lte": end_date}}).sort("time", 1)
    return ticks


if __name__ == "__main__":
    ticks = prepare_ticks("rb", "2022-12-01", "2022-12-26")
    draw_data(ticks)