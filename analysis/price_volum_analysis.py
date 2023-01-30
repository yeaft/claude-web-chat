import click
from helper import constance, utils, date_utils, analysis_helper
from statistics import mean, variance, stdev

DAILY_STATISTIC_INFO_MAP = {}
MAIN_DATES = []
TIME_WEIGHT = {
    2: 0.25,
    5: 0.4,
    20: 0.15,
    60: 0.15,
    120: 0.05
}

def update_sum_ccl(contract_type, start_time = "2022-00-00 00:00:00.000"):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    sec_col = constance.FUTURE_DB['tick_{}_sec'.format(contract_type)]
    count = 0
    for t in main_col.find({"time":{"$lte": start_time}}):        
    # for t in main_col.find({"sum_ccl":{"$exists": False}}):        
        sec_info = sec_col.find_one({'time': {"$lte": t['time']}}, sort=[('time', -1)])
        if sec_info:
            filter = {'time': t['time']}
            newvalues = {"$set": {'sum_ccl': t['ccl'] + sec_info['ccl']}}
            main_col.update_one(filter, newvalues)
        else:
            utils.log("No sec data {}".format(t['time']))
        
        count +=1
    
        if count % 100000 == 1:
            utils.log("Finish {}".format(count))

def daily_ccl_analysis(contract_type, start_date, end_date):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    MAIN_DATES = main_col.distinct("date")
    current_date = start_date
    current_index = MAIN_DATES.index(start_date)
    results = []
    try:
        for i in range(current_index, len(MAIN_DATES)-1):
            start_time = "{} 21:00:00.000".format(MAIN_DATES[i])
            end_time = "{} 15:00:00.000".format(MAIN_DATES[i+1])
            ticks = list(main_col.find({'time': {"$gte": start_time, "$lte": end_time}}))
            if len(ticks) < 10:
                continue

            ccls = list(t['ccl'] for t in ticks)
            sum_ccls = list(t['sum_ccl'] for t in ticks)
            # min_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("ccl",1).limit(1))
            # if len(min_ccls) <1:
            #     continue
            # max_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("ccl",-1).limit(1))
            # min_sum_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("sum_ccl",1).limit(1))
            # max_sum_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("sum_ccl",-1).limit(1))
            zjl = ticks[-1]['ccl'] - ticks[0]["ccl"]
            zjl_per = round(zjl * 100.00 / ticks[0]['ccl'], 2)
            price_diff = ticks[-1]['zxj'] - ticks[0]['zxj']
            price_diff_per = round(price_diff * 100 / ticks[0]['zxj'], 2)
            ccl_impact = round((ticks[-1]['zxj'] - ticks[0]['zxj']) * 10000.00 / zjl, 2)
            result = {
                "date": current_date,
                "type": contract_type,
                "code": ticks[0]['code'],
                "start_ccl": ticks[0]['ccl'],
                "end_ccl": ticks[-1]['ccl'],
                "zjl": zjl,
                "zjl_per": zjl_per,
                "price_diff": price_diff,
                "price_diff_per": price_diff_per,
                "start_price": ticks[0]['zxj'],
                "end_price": ticks[-1]['zxj'],
                "ccl_impact": ccl_impact,
                "min_ccl": int(min(ccls)),
                "avg_ccl": int(mean(ccls)),
                "max_ccl": int(max(ccls)),
                "min_sum_ccl": int(min(sum_ccls)),
                "avg_sum_ccl": int(mean(sum_ccls)),
                "max_sum_ccl": int(max(sum_ccls)),
                # "min_ccl_time": min_ccls[0]['time'],
                # "max_ccl_time": max_ccls[0]['time'],
                # "min_sum_ccl_time": min_sum_ccls[0]['time'],
                # "max_sum_ccl_time": max_sum_ccls[0]['time'],                
            }
            result["ccl_diff"] = result['max_ccl'] - result['min_ccl']
            result["sum_ccl_diff"] = result['max_sum_ccl'] - result['min_sum_ccl']
            results.append(result)
            utils.log("Finish {} - {}".format(start_time, end_time))
        if len(results) > 0:
            ccl_statistic_daily_col = constance.FUTURE_DB['ccl_statistic_daily']
            ccl_statistic_daily_col.delete_many({"type": contract_type, "date": {"$gte": results[0]['date'], "$lte": results[-1]['date']}})
            ccl_statistic_daily_col.insert_many(results)
        utils.convert_dic_to_csv("ccl_min_max", results)        
    except Exception as e:
        utils.log(e)
        utils.log("Results: {}".format(results))
        
    return

def dehydrate(contract_type, current_date, meet_last_days = 10):
    return 

def get_daily_statistic_info(contract_type, look_back_days = 5):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    MAIN_DATES = main_col.distinct("date")

    for i in range(look_back_days, len(MAIN_DATES)):
        start_date = MAIN_DATES[i-look_back_days]
        end_date = MAIN_DATES[i]
        utils.log("Statistic data from {} to {}".format(start_date, end_date))
        missing_count, daily_info = 0, []
        for i in range(0, 2):
            daily_info.append({
                "type": contract_type,
                "date": end_date,
                "look_back_days": look_back_days,
                "is_day": i == 0,
                "cjls": [],
                "ccl_ups": [],
                "ccl_downs": [],
                "zxj_ups": [],
                "zxj_downs": []
            })

        for statistic in constance.CCL_CJL_ZXJ_STATISTIC_COL.find({"type": contract_type, "date": {"$gte": start_date, "$lt": end_date}}):
            statistic_time = statistic['time'].split(" ")[1]
            if statistic_time >= "09:00:00.000" and statistic_time <= "15:00:00.500":
                i = 0
            elif statistic_time >= "21:00:00.000" and statistic_time <= "23:00:00.500":
                i = 1
            else:
                missing_count += 1
                continue
            
            daily_statistic_info = daily_info[i]
            daily_statistic_info['cjls'].append(statistic['cjl'])

            if statistic['ccl_diff'] > 0:
                daily_statistic_info['ccl_ups'].append(statistic['ccl_diff'])
            elif statistic['ccl_diff'] < 0:
                daily_statistic_info['ccl_downs'].append(statistic['ccl_diff'])
            
            if statistic['zxj_diff'] > 0:
                daily_statistic_info['zxj_ups'].append(statistic['zxj_diff'])
            elif statistic['zxj_diff'] < 0:
                daily_statistic_info['zxj_downs'].append(statistic['zxj_diff'])
            
        if missing_count > 0:
            utils.log("missing count {}".format(missing_count))

        results = []
        for i in range(0, 2):
            info = daily_info[i]
            ccl_ups = info['ccl_ups']
            ccl_downs = info['ccl_downs']
            zxj_ups = info['zxj_ups']
            zxj_downs = info['zxj_downs']
            if len(ccl_ups) <= 2 or len(ccl_downs) <= 2 or len(zxj_ups) <= 2 or len(zxj_downs) <= 2:
                utils.log("No {} ccl cjl zxj statistic data in {} {}".format(
                    contract_type, end_date, "day" if i == 0 else "night"))
                utils.log("Size ccl_ups {}, ccl_downs {}, zxj_ups {}, zxj_downs {} ".format(
                    len(ccl_ups), len(ccl_downs), len(zxj_ups), len(zxj_downs)))
                continue
            results.append({  
                "type": contract_type,
                "date": end_date,
                "look_back_days": look_back_days,
                "is_day": i == 0,
                "cjl_avg": int(mean(info["cjls"])),
                "cjl_stdev": int(stdev(info["cjls"])),
                "ccl_ups_avg": int(mean(info["ccl_ups"])),
                "ccl_ups_stdev": int(stdev(info["ccl_ups"])),
                "ccl_downs_avg": int(mean(info["ccl_downs"])),
                "ccl_downs_stdev": int(stdev(info["ccl_downs"])),
                "zxj_ups_avg": round(mean(info["zxj_ups"]), 2),
                "zxj_ups_stdev": round(stdev(info["zxj_ups"]), 2),
                "zxj_downs_avg": round(mean(info["zxj_downs"]), 2),
                "zxj_downs_stdev": round(stdev(info["zxj_downs"]), 2),
            })
        if len(results) > 0:
            constance.DAILY_STATISTIC_INFO_COL.delete_many(
                {"type": contract_type, "date": end_date, "look_back_days": look_back_days})
            constance.DAILY_STATISTIC_INFO_COL.insert_many(results)
            utils.log("Daily statistic {} finished".format(end_date))
    return

# 1. continous 3 > avg + stdev
# 2. past 5 larger than 10000
# 3. ticks must be 5 sec span
def cjl_abnormal_signal(contract_type, current_time, look_back_days=5, cjl_threashold = 10000):
    col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(contract_type)]
    ticks = col.find({"time" : {"$lte": current_time}}).sort("time", -1).limit(5)
    if len(ticks) <= 5:
        return "None"
    ticks.sort(key=lambda x: x['time'])
    

    tick = ticks[-1]
    day_status = "day" if tick['time'] >= "08:59:00.000" and tick['time'] <= "15:00:00.500" else "night"
    current_date = tick['date']
    # Get tick static information
    if current_date not in DAILY_STATISTIC_INFO_MAP:
        DAILY_STATISTIC_INFO_MAP[current_date] = {}
        DAILY_STATISTIC_INFO_MAP[current_date]["day"] = constance.DAILY_STATISTIC_INFO_COL.find_one({"type": tick['type'], "date": tick['date'], "look_back_days": look_back_days, "is_day": True })
        DAILY_STATISTIC_INFO_MAP[current_date]["night"] = constance.DAILY_STATISTIC_INFO_COL.find_one({"type": tick['type'], "date": tick['date'], "look_back_days": look_back_days, "is_day": False })

    
    if day_status not in DAILY_STATISTIC_INFO_MAP[current_date]:
        return "None"
    
    statistic_info = DAILY_STATISTIC_INFO_MAP[current_date][day_status]
    cjl_sum, three_in_row = 0, True
    for i in range(0, 5):
        tick = ticks[len(ticks) - i - 1]
        cjl_sum += tick['cjl']
        if cjl_sum >= cjl_threashold:
            return "SignificantAbnormal"
        if i < 3:
            three_in_row = three_in_row and tick['cjl'] >= statistic_info['cjl_avg'] + statistic_info['cjl_stdev']
    
    if three_in_row:
        return "Abnormal"
        
    return "None"

def ccl_status_analysis():
    # Get past 30 days min max ccl

    return


def get_percentage(start, end):
    return round((end - start) * 100 / end, 2)

def ccl_abnormal_signal(ccl_trend_data):
    signal = "None"
    # strong signal
    # Cut's logic is totally different with open. Cut should be steep, and open will be more like wait and go    
    # if ccl_trend_data[2] + ccl_trend_data[5] <= -12:
    #     if ccl_trend_data[20] <= -2 and ccl_trend_data[60] >= 2:
    #         signal = "StartCutTrend"
        # elif ccl_trend_data[20] > 3 and ccl_trend_data[60] > 3:
        #     signal = "ReverseToCut"        
    # el
    if ccl_trend_data[2] + ccl_trend_data[5] >= 11:
        if ccl_trend_data[20] >= -1 and ccl_trend_data[20] <=4 and ccl_trend_data[60] >= -1 and ccl_trend_data[60] <= 4:
            if ccl_trend_data[20] + ccl_trend_data[60] < 7:
                signal = "StartOpenTrend"
            else:
                if ccl_trend_data[2] + ccl_trend_data[5] >= 12:
                    signal = "StartOpenTrend"
            
        # elif ccl_trend_data[20] < -3 and ccl_trend_data[60] < -3:
        #     signal = "ReverseToOpen"
    
    return signal
    
def verify_ccl_trend_point(contract_type, current_time, is_log = False):
    five_sec_main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    end_tick = five_sec_main_col.find_one({"time": {"$lte": current_time}}, sort=[('time', -1)])
    ccl_trend_data, price_trend_data = {}, {}
    for i in [2, 5, 20, 60, 120]:
        start_tick = list(five_sec_main_col.find({"time": {"$lt": current_time}}).sort('time', -1).skip(i*120).limit(1))[0]
        percentage = analysis_helper.get_percentage(start_tick['ccl'], end_tick['ccl'])
        zxj_percentage = analysis_helper.get_percentage(start_tick['zxj'], end_tick['zxj'])
        ccl_trend_data[i] = analysis_helper.get_ccl_trend_value(i, percentage)
        price_trend_data[i] = analysis_helper.get_zxj_trend_value(
            i, zxj_percentage)

        if is_log:
            utils.log("Date from {} to {}".format(start_tick['time'], current_time))
            # utils.log("  zxj: {} minutes percentage is {}%, trend is {}".format(i, zxj_percentage, price_trend_data[i]))
            utils.log("  ccl: {} minutes percentage is {}%, trend is {}".format(i, percentage, ccl_trend_data[i]))
            utils.log("----------------------------------")
    
    # utils.log("price trend value {}".format(zxj_final_value))
    # utils.log("ccl trend value {}".format(ccl_final_value))
    if is_log:
        utils.log("Signal is {}".format(ccl_abnormal_signal(ccl_trend_data)))
    return ccl_trend_data, price_trend_data

def ccl_cjl_price_avg_dev(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    MAIN_DATES = main_col.distinct("date")
    start_index, step, cjl_sum, statistic_datas = -1, 10, 0, []
    for d in MAIN_DATES:
        ticks = list(main_col.find({"date": d}).sort("time", 1))
        for i in range(0, len(ticks)):
            # Every time start at 09 or 21        
            tick_time = ticks[i]['time'].split(" ")[-1].split(".")[0]
            if tick_time < "09:00:00":
                continue

            if tick_time == "09:00:00" or tick_time == "21:00:00":
                start_index = i
                cjl_sum = 0

            if i - start_index == step:
                start_tick = ticks[start_index]
                tick = ticks[i-1]
                statistic_data = {
                    "type": contract_type,
                    "code": tick['code'],
                    "date": tick['time'].split(" ")[0],
                    "time": tick['time'],
                    "cjl": cjl_sum,
                    "ccl_diff": tick['ccl'] - start_tick['ccl'],
                    "zxj_diff": tick['zxj'] - start_tick['zxj'],
                    "time_range": "{}--{}".format(start_tick['time'], tick['time'])
                }
                statistic_datas.append(statistic_data)

                if len(statistic_datas) >= 100000:
                    utils.log("Get {} data from {} to {}".format(
                        len(statistic_datas), statistic_datas[0]['time'], statistic_datas[-1]['time']))
                    constance.CCL_CJL_ZXJ_STATISTIC_COL.delete_many(
                        {"time": {"$gte": statistic_datas[0]['time'], "$lte": statistic_datas[-1]['time']}})
                    constance.CCL_CJL_ZXJ_STATISTIC_COL.insert_many(statistic_datas)
                    statistic_datas = []

                start_index = i
                cjl_sum = 0

            cjl_sum += ticks[i]['cjl']
    
    if len(statistic_datas) > 0:
        utils.log("Get {} data from {} to {}".format(len(statistic_datas), statistic_datas[0]['time'], statistic_datas[-1]['time']))
        constance.CCL_CJL_ZXJ_STATISTIC_COL.delete_many(
            {"time": {"$gte": statistic_datas[0]['time'], "$lte": statistic_datas[-1]['time']}})
        constance.CCL_CJL_ZXJ_STATISTIC_COL.insert_many(statistic_datas)

    return


# Refer to past 5 days, day or night cjl avg and stdev.
def cjl_avg_dev(contract_type, start_date):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    cjl_daily_statics = []
    while start_date <= "2022-12-11":
        for i in range(0, 2):
            cjls = []
            if i == 0:
                start_time = "{} 21:00:00.000".format(start_date)
                start_date = date_utils.datestr_add_days(start_date, 1, "-")
                end_time = "{} 13:30:00.000".format(start_date)
            else:
                start_time = "{} 09:00:00.000".format(start_date)
                end_time = "{} 15:00:00.000".format(start_date)

            for t in main_col.find({"time": time_filter(start_time, end_time)}):
                cjls.append(t['cjl'])
            if len(cjls) > 0:
                cjl_daily_statics.append({
                    "date": start_date,
                    "isDay": i,
                    "cjlAvg": mean(cjls),
                    "cjlStdev": stdev(cjls)
                })
                utils.log("{}, {}, {}, {}".format(start_date, i, mean(cjls), len(cjls)))
    
    utils.log(cjl_daily_statics)
    constance.FUTURE_DB['tick_{}_cjl_daily_statics'.format(contract_type)].insert_many(cjl_daily_statics)
        
        

    # day_ticks = get_yesterday_day_ticks_by_date("sa209", "20220408", "090000", "150000")
    # night_ticks = get_yesterday_day_ticks_by_date("sa209", "20220408", "210000", "230000")
    # update_factors(day_ticks, {})
    # update_factors(night_ticks, {})
    return

def time_filter(start_time, end_time):
    return {
        "$gte": start_time,
        "$lte": end_time
    }

def check_trend_accuracy(contract_type, start_date, end_date):
    position = {}
    trade_history = []

    main_col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(contract_type)]
    utils.log("Start check")
    results = set()
    skip_count = 0
    for tick in main_col.find({"date": {"$gte": start_date, "$lte": end_date}}).sort("time", 1):
        if skip_count > 0:
            skip_count -= 1
            continue
        ccl_trend_data, price_trend_data = verify_ccl_trend_point(contract_type, tick['time'])
        if position:
            #Go to close strategy
            #First check loss cut logic
            #Check win cut logic
            cjl_status = cjl_abnormal_signal(contract_type, tick['time'])
        else:        
            
            signal = ccl_abnormal_signal(ccl_trend_data)
            if signal != "None":
                trend_str = ""
                for k,v in ccl_trend_data.items():
                    trend_str += "{}_{} ".format(k,v)
                result = "{} {} {}".format(tick['time'], signal, trend_str)
                results.add(result)
                skip_count = 60
            else:
                skip_count = 12
    results = list(results)
    results.sort()
    utils.log("{}".format(results))
    
if __name__ == "__main__":
    # update_sum_ccl("rb", "2021-11-30 21:00:00.000")
    # output_csv("rb")
    # cjl_avg_dev("rb", "2020-01-01")
    # daily_ccl_analysis("rb", "2020-01-08", "2022-12-31")
    # ccl_cjl_price_avg_dev("rb")
    # get_daily_statistic_info("rb")
    verify_ccl_trend_point("rb", "2022-12-09 09:02:00.500", True)
    # check_trend_accuracy("rb", "2022-12-01", "2022-12-31")
    # missing: "2022-12-08 22:40:00" "12-13 21:11" "12-26 21:40" "12-15 11:02"



