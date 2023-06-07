from helper import constance, utils, date_utils, analysis_helper, ticks_helper
from statistics import mean, variance, stdev
from scipy.signal import find_peaks
import pandas as pd
import numpy as np

# check correlation
def zxj_ccl_correlation(ticks):
    zxjs, ccls = [], []
    code = ""
    for x in ticks:
        code = x['code']
        zxjs.append(x['zxj'])
        ccls.append(x['sum_ccl'])

    if len(zxjs) < 10 or len(ccls) < 10:
        return None
    
    correlation = np.corrcoef(zxjs, ccls)
    # utils.log("{}-{} correlation: {}".format(ticks[0]['time'], ticks[-1]['time'], correlation[0][1]))
    return {
        "startTime": ticks[0]['time'],
        "endTime": ticks[-1]['time'],
        "code": code,
        "correlation": correlation[0][1]
    }

def zxj_ccl_correlation_statistic(contract_type):    
    dates = ticks_helper.get_ticks_dates(contract_type)
    results = []
    for date in dates:
        ticks = ticks_helper.get_ticks(date, date, contract_type, "5sec")
        corre = zxj_ccl_correlation(ticks)
        if corre != None:
            results.append(corre)
        
    utils.convert_dic_to_csv("correlation_{}".format(contract_type), results)


def ccl_percentile_distribute(ccls):
    min_ccl = np.min(ccls)
    q1 = np.percentile(ccls, 25)
    median = np.percentile(ccls, 50)
    q3 = np.percentile(ccls, 75)
    max_ccl = np.max(ccls)
    # utils.log("min {}, q1 {}, median {}, q3 {}, max {}".format(min_ccl, q1, median, q3, max_ccl))
    return {
        "min": min_ccl,
        "q1": q1,
        "median": median,
        "q3": q3,
        "max": max_ccl
    }
    # plt.boxplot(ccls)
    # plt.show()    


def calculate_macd(data, short_window, long_window, field_name, span=9):
    """Calculate MACD, MACD Signal and MACD difference

    :param data: DataFrame which contains 'close' column to calculate MACD
    :param short_window: length of short moving average
    :param long_window: length of long moving average
    :return: original DataFrame with new 'macd', 'signal' and 'histogram' columns
    """
    short_ema = data[field_name].ewm(span=short_window, adjust=False).mean()
    long_ema = data[field_name].ewm(span=long_window, adjust=False).mean()

    data['MACD'] = short_ema - long_ema
    data['Signal'] = data['MACD'].ewm(span= span, adjust=False).mean()
    data['MACD_Histogram'] = data['MACD'] - data['Signal']

    return data
def volume_trend_analysis_macd(ticks, span_type="5sec", current_status = {}, is_log = False):
    # Convert list of ticks to DataFrame
    df = pd.DataFrame(ticks)
    df['time'] = pd.to_datetime(df['time'])
    df.set_index('time', inplace=True)

    # Calculate MACD
    two_mins_span = ticks_helper.get_x_span_number(1, span_type=span_type, unit="m")
    five_mins_span = ticks_helper.get_x_span_number(30, span_type=span_type, unit="s")
    twelve_mins_span = ticks_helper.get_x_span_number(5, span_type=span_type, unit="m")

    df = calculate_macd(df, two_mins_span, twelve_mins_span, "sum_ccl", five_mins_span)
    return round(df['MACD_Histogram'][-1], 2)

# We need to catch the trend, it should be start or middle of a trend    
def volume_trend_analysis(ticks, span_type="5sec", current_status = {}, is_log = False):
    #Detect the begin of a open trend
    # zxjs = [x['zxj'] for x in ticks]
    ccls = [x['sum_ccl'] for x in ticks]
    
    #1. have enough bullet    
    # five_days_span = ticks_helper.get_x_span_number(5, span_type=span_type, unit="d")
    # twenty_mins_span = ticks_helper.get_x_span_number(20, span_type=span_type, unit="m")
    # percentile_index = len(ticks) - five_days_span
    # volume_floor = ccl_percentile_distribute(ccls[percentile_index:])['q3']
    # if ticks[-1]['sum_ccl'] > volume_floor:
    #     return False, 0

    # if is_log:
    #     utils.log("Pass volume floor check")
    
    #2. have correlation with zxj latest 2 hours
    # two_hours_span = ticks_helper.get_x_span_number(2, span_type=span_type, unit="h")
    # correlation_index = len(ticks) - two_hours_span
    # correlation_value = zxj_ccl_correlation(
    #     ticks[correlation_index:-1*twenty_mins_span])['correlation']
    # if abs(correlation_value) < 0.5:
    #     if is_log:
    #         utils.log("Correlation value is too low: {}".format(correlation_value))
    #     return False, correlation_value
    # if is_log:
    #     utils.log("Pass correlation check")
    correlation_value = 0

    #3. Position check
    volume_arr = np.array(ccls)
    # ninty_min_span = ticks_helper.get_x_span_number(
    #     90, span_type=span_type, unit="m")
    # peaks, _ = find_peaks(volume_arr, width=ninty_min_span)
    # valleys, _ = find_peaks(-volume_arr, width=ninty_min_span)

    two_hour_span = ticks_helper.get_x_span_number(
        2, span_type=span_type, unit="h")
    peaks, _ = find_peaks(volume_arr, width=two_hour_span)
    valleys, _ = find_peaks(-volume_arr, width=two_hour_span)
                            
    if len(peaks) <= 0 or len(valleys) <= 0:
        return False, correlation_value
    
    last_peak_index = peaks.tolist()[-1]
    last_valley_index = valleys.tolist()[-1]
    peak = ticks[last_peak_index]
    valley = ticks[last_valley_index]
    ccl_max_diff = peak['sum_ccl'] - valley['sum_ccl']
    end_tick = ticks[-1]

    # If lateast ccl diff with last peak or valley is too small, then it is not a good time to open
    if last_peak_index > last_valley_index:
        if peak['sum_ccl'] - end_tick['sum_ccl'] <= ccl_max_diff * 0.6:
            return False, correlation_value
    else:
        if end_tick['sum_ccl'] - valley['sum_ccl'] <= ccl_max_diff * 0.6:
            return False, correlation_value
    
    #4. Trend is start to up
    ccl_trend_data, price_trend_data = {}, {}
    for i in [2, 5, 10, 20, 60, 120]:
        i_mins_span = ticks_helper.get_x_span_number(i, span_type=span_type, unit="m")
        start_tick_index = len(ticks) - i_mins_span
        start_tick = ticks[start_tick_index]
        percentage = analysis_helper.get_percentage(start_tick['ccl'], end_tick['ccl'])
        ccl_trend_data[i] = analysis_helper.get_ccl_trend_value(i, percentage)
    
    signal = ""
    if ccl_trend_data[2] - ccl_trend_data[5] >=7 and ccl_trend_data[2] >= 3:
        signal = "StartOpenTrend"
        # if ccl_trend_data[60] < -4:
            # and ccl_trend_data[60] <= 2:
            # signal = "StartOpenTrend"
            # correlation_value = 1
    # elif ccl_trend_data[2] - ccl_trend_data[5] <= -9 and ccl_trend_data[2] <= -4:
    #     if ccl_trend_data[60] > 4:
    #         signal = "StartCutTrend"
    #         correlation_value = 0

        # if ccl_trend_data[20] >= -1 and ccl_trend_data[20] <= 4 and ccl_trend_data[60] >= -1 and ccl_trend_data[60] <= 4 and ccl_trend_data[120] > 0:
        #     if ccl_trend_data[20] + ccl_trend_data[60] < 7:
        #         signal = "StartOpenTrend"
        #     else:
        #         if ccl_trend_data[2] + ccl_trend_data[5] >= 12:
        #             signal = "StartOpenTrend"         
    if signal == "":
        return False, correlation_value
    
    if is_log:
        utils.log("Pass trend check")

    # last peaks
    utils.log("Last peak time: {}, last valley time: {}, current time {}".format(peak['time'], valley['time'], end_tick['time']))
    return True, correlation_value

def sitimulate_trend(ticks, span_type):
    one_hour_span = ticks_helper.get_x_span_number(1, span_type=span_type, unit="h")
    one_minute_span = ticks_helper.get_x_span_number(1, span_type=span_type, unit="m")
    five_minute_span = ticks_helper.get_x_span_number(5, span_type=span_type, unit="m")
    five_days_span = ticks_helper.get_x_span_number(2, span_type=span_type, unit="d")
    i = five_days_span
    results = []
    macds = []
    while i < len(ticks):
        # is_trend, correlation = volume_trend_analysis(ticks[i - five_days_span:i+1], span_type)
        macd = volume_trend_analysis_macd(
            ticks[i - five_days_span:i+1], span_type)
        macds.append({ "time": ticks[i]['time'], "macd": macd })
        correlation = 0
        if macd > 300 or macd < -300:
            # next_2_hours_correlation = next_x_hours_correlation(ticks, i, span_type, x=2)
            result = {
                "time": ticks[i]['time'],
                "code": ticks[i]['code'],
                "index": i,
                "zxj": ticks[i]['zxj'],
                "ccl": ticks[i]['sum_ccl'],
                "correlation": macd,
                # "next_correlation": next_2_hours_correlation,
                # "is_trend": next_2_hours_correlation != None and ((correlation > 0.5 and next_2_hours_correlation > 0.5) or (correlation < -0.5 and next_2_hours_correlation < -0.5))
                "is_trend": macd > 2 or macd < -2
            }
            results.append(result)
            i += one_minute_span
            continue
            # utils.log("Trend start at {}".format(ticks[i]['time']))
    
        i += one_minute_span
    
    macd_vals = [x['macd'] for x in macds]
    avg_macd = sum(macd_vals) / len(macd_vals)
    stdev_macd = np.std(macd_vals)
    utils.log("Avg macd: {}, stdev: {}".format(avg_macd, stdev_macd))
    utils.log("Get {} tips".format(len(results)))
    utils.convert_dic_to_csv("trend_{}_verify".format(span_type), results)
    return results
    
        
def next_x_hours_correlation(ticks, current_index, span_type, x=1):
    x_hour_span = ticks_helper.get_x_span_number(x, span_type=span_type, unit="h")
    if current_index + x_hour_span > len(ticks):
        return None
    
    zxjs = [x['zxj'] for x in ticks[current_index + 1:current_index+x_hour_span]]
    ccls = [x['sum_ccl'] for x in ticks[current_index + 1:current_index+x_hour_span]]
    return np.corrcoef(zxjs, ccls)[0][1]
    

if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-11-01", "2022-12-11", "rb", span_type)
    # ticks = ticks_helper.get_ticks_by_time("2022-12-05 10:05:00.000", "rb", span_type)
    utils.log("get {} ticks".format(len(ticks)))
    # volume_trend_analysis(ticks, span_type = span_type, is_log=True)
    sitimulate_trend(ticks, span_type)
    
