import click
from helper import constance, utils, date_utils
from statistics import mean, variance, stdev

def update_sum_ccl(contract_type, start_time = "0000-00-00 00:00:00.000"):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    sec_col = constance.FUTURE_DB['tick_{}_sec'.format(contract_type)]
    count = 0
    # for t in main_col.find({"time":{"$gte": start_time}}):        
    for t in main_col.find({"sum_ccl":{"$exists": False}}):        
        sec_infos = list(sec_col.find({'time': {"$lte": t['time']} }).sort("time", -1).limit(1))
        if len(sec_infos) > 0 :
            sec_info = sec_infos[0]
            filter = {'time': t['time']}
            newvalues = {"$set": {'sum_ccl': t['ccl'] + sec_info['ccl']}}
            main_col.update_one(filter, newvalues)
        else:
            utils.log("No sec data {}".format(t['time']))
        
        count +=1
    
        if count % 100000 == 1:
            utils.log("Finish {}".format(count))

def output_csv(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    # c = 0
    with open("rb.csv", "w") as f:
        for t in main_col.find({"time":{"$gte":"2020-03-02 08:59:00.500", "$lte":"2022-01-01 00:00:00.000"}}):        
            f.write("{},{},{},{}\n".format(t['time'], t['zxj'], t['ccl'], t['sum_ccl']))
            # c+=1
            # if c >= 300000:
            #     return

def daily_ccl_analysis(contract_type, start_date, end_date):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    current_date = start_date
    results = []
    try:
        while current_date < end_date:
            if not date_utils.is_work_day(current_date):
                current_date = date_utils.datestr_add_days(current_date, 1, "-")
                continue

            start_time = "{} 21:00:00.000".format(current_date)
            current_date = date_utils.datestr_add_days(current_date, 1, "-")
            while not date_utils.is_work_day(current_date):
                current_date = date_utils.datestr_add_days(current_date, 1, "-")

            end_time = "{} 15:00:00.000".format(current_date)
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

def get_daily_statistic_info(contract_type, current_date, look_back_days = 5):
    start_date, count = current_date, look_back_days
    while count > 0:
        start_date = date_utils.datestr_add_days(start_date, -1, "-")
        if not date_utils.is_work_day(start_date):            
            continue
        count -= 1
    utils.log("Statistic data from {} to {}".format(start_date, current_date))
    missing_count, daily_info = 0, []
    for i in range(0, 2):
        daily_info.append({
            "type": contract_type,
            "date": current_date,
            "look_back_days": look_back_days,
            "is_day": i == 0,
            "cjls": [],
            "ccl_ups": [],
            "ccl_downs": [],
            "zxj_ups": [],
            "zxj_downs": []
        })

    for statistic in constance.CCL_CJL_ZXJ_STATISTIC_COL.find({"type": contract_type, "date": {"$gte": start_date, "$lt": current_date}}):
        statistic_time = statistic['time'].split(" ")[1]
        if statistic_time >= "09:00:04.500" and statistic_time <= "15:00:00.500":
            i = 0
        elif statistic_time >= "21:00:04.500" and statistic_time <= "23:00:00.500":
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
                contract_type, current_date, "day" if i == 0 else "night"))
            utils.log("Size ccl_ups {}, ccl_downs {}, zxj_ups {}, zxj_downs {} ".format(
                len(ccl_ups), len(ccl_downs), len(zxj_ups), len(zxj_downs)))
            continue
        results.append({  
            "type": contract_type,
            "date": current_date,
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
        constance.DAILY_STATISTIC_INFO_COL.delete_many({"type": contract_type, "date": current_date, "look_back_days": look_back_days})
        constance.DAILY_STATISTIC_INFO_COL.insert_many(results)
        utils.log("Daily statistic {} finished".format(current_date))
    return

# 1. Continous 
def ccl_abnormal(ticks, current_index,  look_back_days = 5):    
    daily_statistic_info_map = {}
    if current_index <= 60:
        return False

    tick = ticks[current_index]
    day_status = "day" if tick['time'] >= "08:59:00.000" and tick['time'] <= "15:00:00.500" else "night"
    current_date = tick['date']
    # Get tick static information
    if current_date not in daily_statistic_info_map:
        daily_statistic_info_map[current_date] = {}
        daily_statistic_info_map[current_date]["day"] = constance.DAILY_STATISTIC_INFO_COL.find_one({"type": tick['type'], "date": tick['date'], "look_back_days": look_back_days, "is_day": True })
        daily_statistic_info_map[current_date]["night"] = constance.DAILY_STATISTIC_INFO_COL.find_one({"type": tick['type'], "date": tick['date'], "look_back_days": look_back_days, "is_day": False })

    statistic_info = daily_statistic_info_map[current_date][day_status]
    if not statistic_info:
        return False

    # Get past 30 days min max ccl



    
    return

def ccl_cjl_price_avg_dev(contract_type, start_time = "0000-00-00 00:00:00.000", end_time = "9999-99-99 99:99:99.999"):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    count, step, start_tick, cjl_sum, statistic_datas = 0, 10, None, 0, []
    for tick in main_col.find({"time": {"$gte": start_time, "$lt": end_time}}).sort("time", 1):
        # If change code, then ignore existed data
        if not start_tick or start_tick['code'] != tick['code']:
            start_tick = tick
            cjl_sum = tick['cjl']
            count = 0
            continue        

        cjl_sum += tick['cjl']
        count += 1
        if count % step == 9:
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

            start_tick = tick
            cjl_sum = tick['cjl']
            count = 0
    
    if len(statistic_datas) > 0:
        utils.log("Get {} data from {} to {}".format(len(statistic_datas), statistic_datas[0]['time'], statistic_datas[-1]['time']))
        constance.CCL_CJL_ZXJ_STATISTIC_COL.delete_many(
            {"time": {"$gte": statistic_datas[0]['time'], "$lte": statistic_datas[-1]['time']}})
        constance.CCL_CJL_ZXJ_STATISTIC_COL.insert_many(statistic_datas)

    return


# 1. current past 10s larger than past 10-40s summary.
# 2. current 10s is 3 times than past 10-20s
# 3. current 10s is larger than a threshold （Average in the last day?111）
def cjl_abnormal(contract_type, start_date, end_date):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    # max_ main_col.find({'time':{"$lte": end_date, "$gte": start_date}}).sort("time", 1):
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
    
if __name__ == "__main__":
    # update_sum_ccl("rb", "2021-11-30 21:00:00.000")
    # output_csv("rb")
    # cjl_avg_dev("rb", "2020-01-01")
    daily_ccl_analysis("rb", "2020-01-01", "2022-12-31")
    # ccl_cjl_price_avg_dev("rb")

    # start_date = "2020-01-10"
    # while start_date < "2023-01-01":
    #     start_date = date_utils.datestr_add_days(start_date, 1, "-")
    #     if date_utils.is_work_day(start_date):
    #         get_daily_statistic_info("rb", start_date)
        

