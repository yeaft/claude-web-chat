from scipy.signal import find_peaks
from datetime import datetime
from helper import constance, utils, date_utils, analysis_helper
from matplotlib.animation import FuncAnimation
from statistics import mean, variance, stdev

import numpy as np
import matplotlib.pyplot as plt

def zxj_ccl_pic(contract_type, start_date, end_date):
    five_sec_main_col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(
        contract_type)]
    ticks = five_sec_main_col.find(
        {"date": {"$gte": start_date, "$lte": end_date}}).sort("time", 1)
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
    ax2 = plt.subplot(2, 1, 2, sharex=ax1)

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
    plt.plot(t, data)
    plt.title("Period: {:.2f}".format(period))
    plt.show()

def prepare_ticks(contract_type, start_date, end_date):
    five_sec_main_col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(
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
    # ticks = prepare_ticks("rb", "2022-12-21", "2022-12-26")
    # find_ccl_period(ticks)
    peaks_test()
    # ccl_abnormal("rb", "2022-08-01", "2022-08-21")

    # zxj_ccl_pic("rb", "2022-08-01", "2022-08-21")
