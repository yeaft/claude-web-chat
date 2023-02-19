from helper import constance, utils, date_utils, analysis_helper, ticks_helper
from statistics import mean, variance, stdev
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
    utils.log("{}-{} correlation: {}".format(ticks[0]['time'], ticks[-1]['time'], correlation[0][1]))
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
    utils.log("min {}, q1 {}, median {}, q3 {}, max {}".format(min_ccl, q1, median, q3, max_ccl))
    return q1
    # plt.boxplot(ccls)
    # plt.show()    
    
def volume_trend_analysis(ticks, span_type="5sec", current_status = {}):
    #Detect the begin of a open trend
    zxjs = [x['zxjs'] for x in ticks]
    ccls = [x['sum_ccl'] for x in ticks]
    
    #1. have enough bullet    
    five_days_span = ticks_helper.get_x_ago_tick_index(5, span_type=span_type, unit="d")
    percentile_index = len(ticks) - 1 - five_day_span
    volume_floor = ccl_percentile_distribute(ccls[percentile_index:])
    if ticks['sum_ccl'] < volume_floor:
        return False
    utils.log("Pass volume floor check")
    
    #2. have correlation with zxj latest 2 hours
    two_hours_span = ticks_helper.get_x_ago_tick_index(2, span_type=span_type, unit="h")
    correlation_index = len(ticks) - 1 - two_hours_span
    correlation_value = zxj_ccl_correlation(ticks[correlation_index:])
    if correlation_value < 0.6:
        utils.log("Correlation value is too low: {}".format(correlation_value))
        return False
    utils.log("Pass correlation check")
    
    #3. Trend is start to up
    end_tick = ticks[-1]
    ccl_trend_data, price_trend_data = {}, {}
    for i in [2, 5, 20, 60, 120]:
        i_mins_span = ticks_helper.get_x_span_number(i, span_type=span_type, unit="m")
        start_tick_index = len(ticks) - 1 - i_mins_span
        start_tick = ticks[start_tick_index]
        percentage = analysis_helper.get_percentage(start_tick['ccl'], end_tick['ccl'])
        ccl_trend_data[i] = analysis_helper.get_ccl_trend_value(i, percentage)
    
    signal = ""
    if ccl_trend_data[2] + ccl_trend_data[5] >= 11:
        if ccl_trend_data[20] >= -1 and ccl_trend_data[20] <= 4 and ccl_trend_data[60] >= -1 and ccl_trend_data[60] <= 4 and ccl_trend_data[120] > 0:
            if ccl_trend_data[20] + ccl_trend_data[60] < 7:
                signal = "StartOpenTrend"
            else:
                if ccl_trend_data[2] + ccl_trend_data[5] >= 12:
                    signal = "StartOpenTrend"         
    if signal == "":
        return False
    
    utils.log("Pass trend check")
    return True

def sitimulate_trend(ticks, span_type):
    one_hour_span = ticks_helper.get_x_ago_tick_index(1, span_type=span_type, unit="h")
    five_days_span = ticks_helper.get_x_ago_tick_index(5, span_type=span_type, unit="d")
    i = five_days_span
    while i < len(ticks):
        if volume_trend_analysis(ticks[i - five_days_span:i+1], span_type):
            i += one_hour_span
            utils.log("Trend start at {}".format(ticks[i]['time']))
            return True
    

if __name__ == "__main__":
    span_type = "5sec"
    ticks = ticks_helper.get_ticks("2022-12-01", "2022-12-11", "rb", span_type)
    utils.log("")
