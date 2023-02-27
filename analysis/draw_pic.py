from scipy.signal import find_peaks
from datetime import datetime
from helper import constance, utils, date_utils, analysis_helper, ticks_helper
from matplotlib.animation import FuncAnimation
from statistics import mean, variance, stdev

import volume_trend_analysis
import numpy as np
import matplotlib.pyplot as plt
from scipy.fftpack import fft

TEXT = None

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

def zxj_ccl_pic_v2(ticks, span_type, with_correlation_value = False):
    price, volume, times, times_arr, codes = [], [], [], [], []
    for x in ticks:
        price.append(x['zxj'])
        volume.append(x['sum_ccl'] if "sum_ccl" in x else x['ccl'])
        times_arr.append(x['time'])
        codes.append(x['code'])

    times = np.arange(len(price))
    volume_arr = np.array(volume)
    two_hour_span = ticks_helper.get_x_span_number(2, span_type=span_type, unit="h")
    peaks, _ = find_peaks(volume_arr, width=two_hour_span)
    valleys, _ = find_peaks(-volume_arr, width=two_hour_span)

    # 创建图表
    fig, ax = plt.subplots()

    # 绘制最新价
    ax.plot(times, price, color='grey', label='Price')

    # 设置右边的y轴
    ax2 = ax.twinx()

    # 绘制持仓量
    ax2.plot(times, volume, color='blue', label='Volume')

    # ax2.plot(peaks, volume_arr[peaks], "x")
    # Draw volume trend
    if with_correlation_value:
        red_infos = volume_trend_analysis.sitimulate_trend(ticks=ticks, span_type=span_type)
        plt.scatter([times[i['index']] for i in red_infos], [volume[i['index']] for i in red_infos], color='red')
        for info in red_infos:
            ax2.text(times[info['index']] - 2, volume[info['index']] + 50,
                    str(round(info['correlation'], 2)))
    
    # 绘制峰值
    ax2.plot(peaks, volume_arr[peaks], "x", color='red')
    ax2.plot(valleys, volume_arr[valleys], "x", color='blue')

    # 设置参考线
    # ax.axvline(x=3, color='black', linestyle='--', label='Reference')

    vline = ax.axvline(x=0, color='black')

    

    # 绘制新的文字对象
    def on_move(event):
        global TEXT
        if not event.inaxes:
            return
        vline.set_xdata(event.xdata)
        
        # utils.log("{}".format(event.xdata))
        index = int(event.xdata)
        if index < len(times_arr):
            information = "{} {} {}".format(codes[index], price[index], times_arr[index])
            # if text:
            #     text.remove()
            if TEXT:
                TEXT.remove()
            TEXT = ax.text(0.3, 1.05, information, transform=ax.transAxes)
            # ax.text(0.7, 0.9, date_str, transform=ax.transAxes)
            # ax.text(event.xdata, event.data, date_str, transform=ax.transData)
            # text.set_text(date_str)
            # text.set_text('x=%s, y=%s, date=%s' % (event.xdata, event.ydata, ))
        fig.canvas.draw()


    fig.canvas.mpl_connect('motion_notify_event', on_move)

    # 设置图例
    ax.legend(loc='upper left')
    ax2.legend(loc='upper right')

    # 显示图表
    plt.show()

def analysis_peak(ticks):
    zxjs, volume_data, times = [], [], []
    for x in ticks:
        zxjs.append(x['zxj'])
        volume_data.append(x['sum_ccl'])
    # 假设持仓量数据为列表 volume_data
    # volume_data = [1, 2, 3, 4, 3, 2, 1, 2, 3, 4, 3, 2, 1]
    N = len(volume_data)
    T = 0.5

    # 计算FFT变换
    y = np.array(volume_data)
    yf = np.abs(fft(y))
    xf = np.linspace(0.0, 1.0/(2.0*T), N//2)

    # 绘制FFT图
    plt.plot(xf, 2.0/N * yf[0:N//2])
    plt.xlabel('Frequency')
    plt.ylabel('Amplitude')
    plt.title('FFT Analysis of Volume Data')
    plt.show()


def zxj_ccl_pic(ticks, peaks = [], valleys = []):
    zxjs, ccls, times = [], [], []
    for x in ticks:
        zxjs.append(x['zxj'])
        ccls.append(x['sum_ccl'])

    times = np.arange(len(zxjs))

    # 计算时间轴
    # 创建一个子图
    ax1 = plt.subplot(2, 1, 1)

    # 绘制价格图像
    plt.plot(times, zxjs, label='price')

    # 添加图例
    plt.legend()

    # 创建第二个子图
    

    # 找出顶点的位置
    # factor = 1
    # data = np.array(ccls)
    # data_relative = data - min(data)
    # peaks, _ = find_peaks(data_relative, rel_height=0.6)
    # v_1, valleys = find_peaks(-data,
    #                         prominence=calculate_prominence(data, factor), distance=1)

    # print("peaks {}".format(peaks))

    # print("valleys {}".format(valleys))
    # print("valleys 2{}".format(v_1))
    
    

    fig, ax = plt.subplots(2, 1, 2)

    vert_line = ax.axvline(0, color='gray', alpha=0.5)
    horz_line = ax.axhline(0, color='gray', alpha=0.5)

    def onmove(event):
        if not event.inaxes:
            return
        x, y = event.xdata, event.ydata
        vert_line.set_data([x, x], [0, 1])
        horz_line.set_data([0, 1], [y, y])
        fig.canvas.draw()

    fig.canvas.mpl_connect('motion_notify_event', onmove)

    if peaks:
        for peak_index in peaks:
            # 添加文本标签
            plt.annotate(f'Peak ({times[peak_index]}, {ccls[peak_index]})', xy=(times[peak_index], ccls[peak_index]), xytext=(times[peak_index] + 0.5, ccls[peak_index] + 5),
                         arrowprops=dict(facecolor='black', shrink=0.05))

    if valleys:
        for peak_index in valleys:
            # 添加文本标签
            plt.annotate(f'Peak ({times[peak_index]}, {ccls[peak_index]})', xy=(times[peak_index], ccls[peak_index]), xytext=(times[peak_index] + 0.5, ccls[peak_index] + 5),
                         arrowprops=dict(facecolor='black', shrink=0.05))

    # 绘制持仓量图像
    plt.plot(times, ccls, label='volume')

    # 添加图例
    plt.legend()

    # 创建动画对象
    # frame = 0
    # ani = FuncAnimation(plt.gcf(), update(frame, times, zxjs, ccls), frames=len(
    #     times)//1000, interval=100)
    # plt.tight_layout()
    plt.show()


# def update(frame, times, price, position):
#     plt.clf()
#     start = frame * 1000
#     end = (frame + 1) * 1000
#     x = times[start:end]
#     y1 = price[start:end]
#     y2 = position[start:end]
#     plt.plot(x, y1, label='Price')
#     plt.plot(x, y2, label='Position')
#     plt.legend(loc='upper left')
#     plt.xlabel('Time')
#     plt.ylabel('Price & Position')
#     frame += 1

def ccl_percentile_distribute(contract_type, start_date, end_date):
    five_sec_main_col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(
        contract_type)]
    ticks = five_sec_main_col.find(
        {"date": {"$gte": start_date, "$lte": end_date}}).sort("time", 1)
    zxjs, ccls, times = [], [], []
    for x in ticks:
        ccls.append(x['sum_ccl'])

    min_ccl = np.min(ccls)
    q1 = np.percentile(ccls, 25)
    median = np.percentile(ccls, 50)
    q3 = np.percentile(ccls, 75)
    max_ccl = np.max(ccls)
    utils.log("")
    # plt.boxplot(ccls)
    # plt.show()


def find_ccl_period(ticks):
    times, ccls = [], []
    for x in ticks:
        times.append(x['time'])
        ccls.append(x['sum_ccl'])
    # 生成模拟的时序数据
    t =  np.array(times)
    t_x = np.arange(len(times))
    data = np.array(ccls)
    # 计算傅里叶变换
    fft = np.abs(np.fft.fft(data))
    freq = np.fft.fftfreq(t.shape[-1])

    # 找到数据中最明显的周期性波动
    peaks, _ = find_peaks(fft)
    
    # peaks, _ = find_peaks(fft, prominence = -1)

    # 计算周期
    period = 1 / freq[peaks[np.argmax(fft[peaks])]]

    # 可视化结果
    utils.log("Period: {:.2f}".format(period/12))
    plt.plot(t_x, data)
    plt.title("Period: {:.2f}".format(period))
    plt.show()


def prepare_ticks(contract_type, start_date, end_date, is_real_tick=False):
    if is_real_tick:
        cols = constance.FUTURE_DB['realTimeTick']
        start_date.replace("-", "")
        end_date.replace("-", "")
        yesterday = date_utils.datestr_add_days(start_date, -1)
        start_time = "{} 210000".format(yesterday)
        end_time = "{} 150000".format(end_date)
        utils.log("Filter {}".format({"type": contract_type,
                                      "time": {"$gte": start_time, "$lte": end_time}}))
        ticks = cols.find({"type": contract_type, "time": {
                          "$gte": start_time, "$lte": end_time}}).sort("time", 1)
    # five_sec_main_col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(
    #     contract_type)]
    else:
        five_sec_main_col = constance.FUTURE_DB['tick_{}_main_1_min'.format(
            contract_type)]
        ticks = five_sec_main_col.find(
            {"date": {"$gte": start_date, "$lte": end_date}}).sort("time", 1)
    return ticks

def peaks_test():
    data = np.array([0, 1, 2, 1, 2, 3, 2, 1, 0, 1, 2, 1, 0, 0, -1, -2, -1, -2])
    high_peaks, _ = find_peaks(data)
    low_peaks, _ = find_peaks(-data, prominence = -1)
    utils.log("Len: {}, high: {}, low: {}".format(len(data), high_peaks, low_peaks))
    



if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-11-01", "2022-12-01", "rb", span_type)
    utils.log("Len: {}".format(len(ticks)))
    # zxj_ccl_pic(ticks)
    # analysis_peak(ticks)
    zxj_ccl_pic_v2(ticks, span_type=span_type, with_correlation_value=True)
    # find_ccl_period(ticks)
    # peaks_test()

    
    # ccl_abnormal("rb", "2022-08-01", "2022-08-21")

    # zxj_ccl_pic("rb", "2022-08-01", "2022-08-21")
