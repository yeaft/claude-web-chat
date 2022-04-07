import time
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from pymongo import MongoClient, DESCENDING, ASCENDING
from statistics import mean, variance, stdev

# Status flow: none|confirm => verifying => preliminaryConfirm => confirm(current or rollback)

def start_mark(last_peak, ticks, records, price_diff, peak_price):
    last_peak_tick = ticks[last_peak['index']]
    if last_peak['status'] == "confirm":
        trigger_a_peak(ticks, last_peak)
        # TODO: Alert to open a position
    elif last_peak['status'] == "":
        # Try to find the first peak
        initial_first_peak()
    elif last_peak['status'] == "verifing":
        # Do verify
        observe_peak(new_tick, last_peak)
        # TODO: Update position here
    elif last_peak['status'] == "preliminaryConfirm":
        # If pass, check whether mark wrong
        price_diff_confirm(new_tick, last_peak)
        # TODO: Update cut logic here

# 1. second mark must be in "confirm"
# 2. cjl must be increase fast
def trigger_a_peak(ticks, last_peak):
    sub_ticks = ticks[last_peak["index"]:]
    if len(sub_ticks) <= 0:
        return False

    current_tick = ticks[-1]
    if last_peak['type'] == "crest":
        for t in sub_ticks:
            if current_tick['zxj'] > t['zxj']:
                return False
    else:
        for t in sub_ticks:
            if current_tick['zxj'] < t['zxj']:
                return False


    return

def initial_first_peak():
    return 

# 1. If cjl reduce fast, price reduce fast, then pass
# 2. If cjl increase and price still running, then still peaking, add more?
# 3. If no changes, more like a false peak.
# 4. There must be four continuous low cjl then we can say it calm down
def observe_peak():
    return


# 1. If no big price diff and cjl increase, then need to cut
def price_diff_confirm(new_tick, last_peak):
    return

def calculate_last_day_cjl_diff_stdev(code, date):
    start_time = "{0} 090000".format(date)
    end_time = "{0} 230000".format(date)
    ticks = list(domain_utils.constance.REAL_TIME_TICK_COL.find({"code":"sa209", "time":{"$gte":start_time, "$lte":end_time}}))
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
    calculate_last_day_cjl_diff_stdev("sa209", "20220406")