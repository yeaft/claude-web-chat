from pickle import FALSE
import time
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from pymongo import MongoClient, DESCENDING, ASCENDING
from statistics import mean, variance, stdev

# A peak info
# time, type, price, peakIndex, detectedIndex, tradeIndex, confirmIndex
# peak check info
# direction, lastPeak, nextPeak, priceChange, cjlChange, cjlVolume, cjlReduce, observePass
# Factor
# cjl2TimesThreshold, cjl4TimesThreshold, cjlReduceThreshold

# Status flow: none|confirm => watching => triggered => preliminaryConfirm => confirm(current or rollback)
# when pass price and cjl change, we need create a new peak
# A possible bug, lose peak !
# If there are two fail peak, then it means there is false negative peak
def start_mark(ticks, context, peaks, factor, is_pre = False):
    if len(ticks) < 30:
        return
    if len(peaks) == 0:
        pre_peak_find(ticks, peaks)
    if "cjl2TimesThreshold" not in factor:
        if is_pre:
            past_ticks = get_yesterday_day_ticks_by_date(ticks[0]['code'], ticks[0]['time'][:8], "133000", "233000")
        else:
            past_ticks = get_yesterday_day_ticks_by_date(ticks[0]['code'], ticks[0]['time'][:8])
        update_factors(past_ticks, factor)
    if "popTimes" not in context:
        context['popTimes'] = 0
        context['priceChange'] = False
        context['priceChangeDetectIndex'] = 0
        context['cjlChange'] = False
        context['cjlChangeDetectIndex'] = 0
        context['observeBigCjl'] = 0
        
    
    # if ticks[-1]['time'] >= "20220413 112430":
    #     utils.log("Stop here")

    peak = peaks[-1]
    # if ticks[-1] == None:
    #     utils.log("Stop") 
    # try:
    #     if peak['status'] == "observePass":
    #         a = 1
    # except:
    #     utils.log("{}".format(peaks))
    #     return 
    if "observePass" in peak['status']:
        if not false_peak_check(ticks, peaks, context):
            peak = peaks[-1]
        price_change_detect(ticks, peak, context)
        if context['priceChange']:            
            peak = {}
            peak['type'] = "crest" if context['direction'] == "up" else "trough"
            peak['detectedIndex'] = len(ticks) - 1
            peak['time'] = ticks[-1]['time']
            peaks.append(peak)
            update_peak_status(ticks[-1], peak, peak["type"])
            update_peak_status(ticks[-1], peak, "detected")
            cjl_max_volume_check(ticks, peaks, context, factor)
    elif peak['status'] == "detected":
        cjl_max_volume_check(ticks, peaks, context, factor)     
    elif peak['status'] == "increasingPass":
        cjl_reduce_check(ticks, peak, context, factor)
    elif peak['status'] == "reducePass":
        observe_peak(ticks, peaks, peak, context, factor)
            
def update_peak_status(tick, peak, status, context = None, key = ""):
    if key != "":
        context[key] = True
    peak['status'] = status
    tick['status'] = status if 'status' not in tick else "{}-{}".format(tick['status'], status)

# 1. Find past 4 hours ticks price crest, and start from that found each peak
def pre_peak_find(ticks, peaks):
    past_ticks = get_yesterday_day_ticks_by_date(ticks[0]['code'], ticks[0]['time'][:8])
    max_price, min_price, max_index, min_index = 0, 999999, 0, 0
    for i in range(0, len(past_ticks)):
        t = past_ticks[i]
        if t['zxj'] >= max_price:
            max_price = t['zxj']
            max_index = i
        if t['zxj'] <= min_price:
            min_price = t['zxj']
            min_index = i
    
    start_index = max_index if max_index < min_index else min_index

    peak = {}
    peak['time'] = past_ticks[start_index]['time']
    peak['type'] = "crest" if max_index < min_index else "trough"
    peak['price'] = max_price if max_index < min_index else min_price
    peak['status'] = "observePass"
    peak['detectedIndex'] = start_index
    peak['peakIndex'] = start_index    
    peak['tradeIndex'] = start_index
    peak['confirmIndex'] = start_index

    temp_peaks = [peak]
    utils.log("First peak: {}".format(peak))
    context = {}
    factor = {}
    for i in range(start_index + 5, len(past_ticks)):
        start_mark(past_ticks[:i], context, temp_peaks, factor, True)
    
    utils.log("peak_infos: {}".format(temp_peaks))
    # utils.convert_dic_to_csv("peak_infos", temp_peaks)
    peaks.extend(temp_peaks)
    utils.log("In pre find, peaks {}".format(len(peaks)))
    utils.log("----------------------------------------------------")

# 1. If current price same with last_peak, then we should 
def false_peak_check(ticks, peaks, context):
    peak = peaks[-1]
    zxj = ticks[-1]['zxj']
    if (peak['type'] == "crest" and zxj > peak['price']) or \
        (peak['type'] == "trough" and zxj < peak['price']):
        if context['popTimes'] == 1:
            recover_false_negative_peak(ticks, peaks)
            context['popTimes'] = 0
        else:
            utils.log("Current tick: {}".format(ticks[-1]))
            utils.log("Fake peak: {}".format(peak))
            if ticks[-1]['time'][:8] == peak['time'][:8]:
                ticks[peak['confirmIndex']]['status'] += "-adjustFalsePeak-{}-{}".format(ticks[-1]['time'][-6:], ticks[-1]['zxj'])
            if 'status' in ticks[-1]:
                ticks[-1]['status'] += "findError-cut"
            peaks.pop()
            context['popTimes'] += 1
            return False
    return True

# price must be diff than pass 60s
def price_change_detect(ticks, peak, context):
    sub_prices = list(x['zxj'] for x in ticks[-13:-1])
    tick = ticks[-1]
    
    direction = "up" if peak['type'] == "trough" else "down"
    context['direction'] = direction
    if direction == "up" and tick['zxj'] >= 1.002 * min(sub_prices):
        context['priceChange'] = True
        context['priceChangeDetectIndex'] = len(ticks) - 1
    elif direction == "down" and tick['zxj'] <= 0.998 * max(sub_prices):
        context['priceChange'] = True
        context['priceChangeDetectIndex'] = len(ticks) - 1
    else:
        context['priceChange'] = False   

# Once pass this check send a alert, to prepare the trade
# 0. if far away from price detected, then change back
# 1. continous two units >= mean + 2 * stdev
# 2. Or one unit mean + 4 * stdev
# 3. Or past 6 unit sum > past 3 mins sum
def cjl_max_volume_check(ticks, peaks, context, factor):

    # if context['priceChange']:            
    #         peak = {}
    #         peak['type'] = "crest" if context['direction'] == "up" else "trough"
    #         peak['detectedIndex'] = len(ticks) - 1
    #         peak['time'] = ticks[-1]['time']
    #         peaks.append(peak)
    #         update_peak_status(ticks[-1], peak, peak["type"])
    #         update_peak_status(ticks[-1], peak, "detected")
    #         cjl_max_volume_check(ticks, peaks, context, factor)


    # if len(ticks) > context['detectedIndex'] + 4:
    #     context['priceChange'] = False
    #     ticks[peak['detectedIndex']]['status'] += "-falseDetect"
    peak = peaks[-1]
    cjl2TimesThreshold = factor['cjl2TimesThreshold'] if ticks[-1]['time'][-6:] < "210000" else (factor['cjl2TimesThreshold'] * 0.75)
    cjl4TimesThreshold = factor['cjl4TimesThreshold'] if ticks[-1]['time'][-6:] < "210000" else (factor['cjl4TimesThreshold'] * 0.75)    

    # if ticks[-1]['cjlDiff'] >= cjl4TimesThreshold or \
    #     (ticks[-1]['cjlDiff'] >= cjl2TimesThreshold and ticks[-2]['cjlDiff'] >= cjl2TimesThreshold):
    #     update_peak_status(ticks[-1], peak, "increasingPass", context, "cjlVolume")
    if len(ticks) > 30 and len(ticks) - peak['detectedIndex'] < 4:
        latest_6_units_cjl_diff = sum(x['cjlDiff'] for x in ticks[-6:])
        latest_18_units_cjl_diff = sum(x['cjlDiff'] for x in ticks[-24:-6])
        if latest_6_units_cjl_diff >= latest_18_units_cjl_diff:
            if 'status' not in ticks[-1]:
                ticks[-1]['status'] = "volumePass"
            else:
                ticks[-1]['status'] += "-volumePass"

            peak['status'] = "increasingPass"
            context['cjlVolume'] = True
    elif len(ticks) - peak['detectedIndex'] >= 4:
        update_peak_status(ticks[-1], peak, "cjlVolumeFailed")
        update_peak_status(ticks[peak['detectedIndex']], peak, "detectFalse")
        context['priceChange'] = False
        peaks.pop()


# 1. If cjl increase again then change to increase pass status
# 2. Plus next shouldn't be increase two times than current, otherwise it still in trend
# Once pass this check do the trade
# Update position here
def cjl_reduce_check(ticks, peak, context, factor):
    cjlReduceThreshold = factor['cjlReduceThreshold'] if ticks[-1]['time'][-6:] < "210000" else (factor['cjlReduceThreshold'] * 0.75)
    if ticks[-1]['cjlDiff'] <= cjlReduceThreshold or \
        ticks[-1]['cjlDiff'] <= ticks[-2]['cjlDiff'] / 3:
        if 'sendReadyTrade' not in context or not context['sendReadyTrade']:
            #TODO send ready to trade message
            context['sendReadyTrade'] = True

        if (ticks[-2]['cjlDiff'] <= cjlReduceThreshold or ticks[-2]['cjlDiff'] <= ticks[-3]['cjlDiff'] / 3) and \
            ticks[-1]['cjlDiff'] <= 2 * ticks[-2]['cjlDiff']:
            #TODO send trade message
            context['sendTrade'] = True
            context['cjlReduce'] = True
            context['observeBigCjl'] = 0
            update_peak_status(ticks[-1], peak, "reducePass", context, "cjlReduce")
            peak['tradeIndex'] = len(ticks) - 1
            # Calculate peak index
            peak_price = 0
            if peak['type'] == "crest":
                peak_price = 0
                peak_index = peak['detectedIndex']
                for i in range(peak['detectedIndex'], len(ticks)):
                    if ticks[i]['zxj'] > peak_price:
                        peak_price = ticks[i]['zxj']
                        peak_index = i
            else:
                peak_price = 999999
                peak_index = peak['detectedIndex']
                for i in range(peak['detectedIndex'], len(ticks)):
                    if ticks[i]['zxj'] < peak_price:
                        peak_price = ticks[i]['zxj']
                        peak_index = i
            peak['time'] = ticks[-1]['time']
            peak['peakIndex'] = peak_index
            peak['price'] = peak_price            

    context['sendReadyTrade'] = False
    context['cjlReduce'] = False

# 1. If cjl increase again then change to increase pass status, should cut now
# 2. Verify time is 60s, the price should go to a good direction
# Once pass, update peak information
# Update position here
# Update cut logic here, last peak or next peak
def observe_peak(ticks, peaks, peak, context, factor):
    cjl2TimesThreshold = factor['cjl2TimesThreshold'] if ticks[-1]['time'][-6:] < "210000" else (factor['cjl2TimesThreshold'] * 0.75)
    if ticks[-1]['cjlDiff'] >= cjl2TimesThreshold:
        context['observeBigCjl'] += 1
        #TODO send cut message
        if context['observeBigCjl'] > 2:
            peak['status'] = "increasingPass"
            ticks[-1]['status'] = "falseReduce"
            context['cjlReduce'] = False
    else:
        check_index = peak['tradeIndex'] + 12
        direction = "up" if peak['type'] == "trough" else "down"
        if len(ticks) > check_index:            
            peak_tick = ticks[peak['peakIndex']]
            check_tick = ticks[check_index]

            if (direction == "up" and check_tick['zxj'] >= 1.001 * peak_tick['zxj']) or \
                (direction == "down" and check_tick['zxj'] <= 0.999 * peak_tick['zxj']):
                #TODO update loss cut price
                update_peak_status(ticks[-1], peak, "observePass")
                ticks[-1]['status'] += "-trade-{}".format("up" if peak['type'] == "trough" else "down")
                context['observePass'] = True
                peak['confirmIndex'] = check_index
                context['popTimes'] = 0
                context['observeBigCjl'] = 0
            else:
                # Fake peak:
                # 1. TODO: cut position
                ticks[-1]['status'] = "finalPriceObserveFalse"
                peaks.pop()
                context['popTimes'] += 1
                context['observeBigCjl'] = 0
        else:
            if (direction == "up" and ticks[-1]['zxj'] < 0.999 * peak['price']) or \
                (direction == "down" and ticks[-1]['zxj'] > 1.001 * peak['price']):
                # Fake peak:
                # TODO cut position
                ticks[-1]['status'] = "middleObserveFalsePeak"
                peaks.pop()
                context['popTimes'] += 1 
                context['observeBigCjl'] = 0   

# calculate last day, cjl avg, stdev,
# Factor
# cjl2TimesThreshold, cjl4TimesThreshold, cjlReduceThreshold
# Optional: min peak diff in the past.
def update_factors(ticks, factor):
    cjl_diff_arr = list(x['cjlDiff'] for x in ticks)
    avg_cjl_diff = int(mean(cjl_diff_arr))
    stdev_cjl_diff = int(stdev(cjl_diff_arr))

    factor['cjl2TimesThreshold'] = avg_cjl_diff + 1.8 * stdev_cjl_diff
    factor['cjl4TimesThreshold'] = avg_cjl_diff + 4 * stdev_cjl_diff
    factor['cjlReduceThreshold'] = avg_cjl_diff + 1.5 *stdev_cjl_diff
    utils.log("Factor: {}".format(factor))

def get_yesterday_day_ticks_by_date(code, date, st = "090000", et = "150000"):
    infos = list(constance.INFO_COL.find({"code":code, "date":{"$lt":date}}).sort("date", DESCENDING).limit(1))
    if len(infos) == 0:
        return
    
    start_time = "{0} {1}".format(infos[0]['date'], st)
    end_time = "{0} {1}".format(infos[0]['date'], et)

    ticks = list(constance.REAL_TIME_TICK_COL.find({"code":code, "time":{"$gte": start_time, "$lte": end_time}, "cjlDiff": {"$gt": 0}}).sort("time", ASCENDING))
    utils.log("Get day ticks: {}".format(len(ticks)))
    return ticks

# Recover False negative peak, which means all rules are invalidation
# Just find the peak price and add the peak
def recover_false_negative_peak(ticks, peaks):
    peak = peaks[-1]
    missing_peak = {}
    if peak['type'] == "crest":
        missing_peak['price'] = 999999
        missing_peak['type'] = "trough"
        for i in range(peak['peakIndex'], len(ticks)):
            if ticks[i]['zxj'] < missing_peak['price']:
                missing_peak['time'] = ticks[i]['time']
                missing_peak['price'] = ticks[i]['zxj']
                missing_peak['peakIndex'] = i
    else:
        missing_peak['price'] = 0
        missing_peak['type'] = "crest"
        for i in range(peak['peakIndex'], len(ticks)):
            if ticks[i]['zxj'] > missing_peak['price']:
                missing_peak['time'] = ticks[i]['time']
                missing_peak['price'] = ticks[i]['zxj']
                missing_peak['peakIndex'] = i
    
    missing_peak['status'] = "observePass(missing)"
    missing_peak['detectedIndex'] = missing_peak['peakIndex'] 
    missing_peak['tradeIndex'] = missing_peak['peakIndex']
    missing_peak['confirmIndex'] = missing_peak['peakIndex']
    peaks.append(missing_peak)

def calculate_last_day_cjl_diff_stdev(code, date):
    start_date = date_utils.datestr_add_days(date, -5)
    start_time = "{0} 090000".format(start_date)
    end_time = "{0} 230000".format(date)
    ticks = list(domain_utils.constance.REAL_TIME_TICK_COL.find({"code": code, "time":{"$gte":start_time, "$lte":end_time}}))
    cjl_diff_arr = list(x['cjlDiff'] for x in ticks if x['cjlDiff'] > 0)
    cjl_diff_variance = round(variance(cjl_diff_arr), 2)
    cjl_diff_mean = round(mean(cjl_diff_arr), 2)
    cjl_diff_stdev = round(stdev(cjl_diff_arr, xbar=mean(cjl_diff_arr)), 2)
    # 95% 2 stdev, 85% 1 stdev 
    count_larger_2_stdev = sum(1 for x in cjl_diff_arr if (x >= cjl_diff_mean + 3*cjl_diff_stdev))
    selected_times = []
    for t in ticks:
        if t['cjlDiff'] >= cjl_diff_mean + 3*cjl_diff_stdev:
            selected_times.append(t['time'])
    all_num = len(cjl_diff_arr)
    utils.log("variance: {0}, stdev: {1}, mean: {2}, sum: {3}, 99Per: {4}, num: {5}".format(cjl_diff_variance, cjl_diff_stdev, cjl_diff_mean, sum(cjl_diff_arr), round(count_larger_2_stdev * 100 / all_num, 2), all_num))
    utils.log(selected_times)


if __name__ == "__main__":
    # day_ticks = get_yesterday_day_ticks_by_date("sa209", "20220408", "090000", "150000")
    # night_ticks = get_yesterday_day_ticks_by_date("sa209", "20220408", "210000", "230000")
    # update_factors(day_ticks, {})
    # update_factors(night_ticks, {})
    start_time = "20220408 210000"
    end_time = "20220413 150000"
    # calculate_last_day_cjl_diff_stdev("sa209", "20220407")    
    ticks = list(domain_utils.constance.REAL_TIME_TICK_COL.find({"code":"sa209", "time":{"$gte":start_time, "$lte":end_time}, "cjlDiff":{"$gt":0}},{"_id":0, "time":1, "code":1, "zxj":1, "cjlDiff":1}))
    for t in ticks:
        t['status'] = ""
    factor = {}
    context = {}
    peaks = []
    for i in range(3, len(ticks)):
        # if i == 100:
        #     break     
        start_mark(ticks[:i], context, peaks, factor)
    
    utils.log("Peaks: {}".format(peaks))
    utils.convert_dic_to_csv("t_real_peaks", peaks, is_new = False)
    trade_record = []
    for t in ticks:
        if 'trade' in t['status']:
            trade_record.append(t)
        if t['status'] != "" and t['status'][0] == "-":
            t['status'] = t['status'][1:]
    utils.convert_dic_to_csv("t_ticks_record", ticks, is_new = False)
    utils.convert_dic_to_csv("t_trade_record", trade_record, is_new = False)
