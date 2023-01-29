import click
from helper import constance, utils, date_utils
from statistics import mean, variance, stdev

def update_sum_ccl(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    sec_col = constance.FUTURE_DB['tick_{}_sec'.format(contract_type)]
    count = 0
    for t in main_col.find():        
        if count > 0:
            sec_infos = list(sec_col.find({'time': {"$lte": t['time']} }).sort("time", -1).limit(1))
            if len(sec_infos) > 0 :
                sec_info = sec_infos[0]
                filter = {'time': t['time']}
                newvalues = {"$set": {'sum_ccl': t['ccl'] + sec_info['ccl']}}
                main_col.update_one(filter, newvalues)
        
        count +=1
    
        if count % 10000 == 1:
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

def daily_min_max_ccl(contract_type, start_date, end_date):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    current_date = start_date
    results = []
    try:
        while current_date < end_date:
            start_time = "{} 21:00:00.000".format(current_date)
            current_date = date_utils.datestr_add_days(current_date, 1, "-")
            end_time = "{} 15:00:00.000".format(current_date)
            min_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("ccl",1).limit(1))
            if len(min_ccls) <1:
                continue
            max_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("ccl",-1).limit(1))
            min_sum_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("sum_ccl",1).limit(1))
            max_sum_ccls = list(main_col.find({'time':{"$lte": end_time, "$gte": start_time}}).sort("sum_ccl",-1).limit(1))
            result = {
                "date": current_date,
                "code": min_ccls[0]['code'],
                "min_ccl": min_ccls[0]['ccl'],
                "min_ccl_time": min_ccls[0]['time'],
                "min_sum_ccl": min_sum_ccls[0]['sum_ccl'],
                "min_sum_ccl_time": min_sum_ccls[0]['time'],
                "max_ccl": max_ccls[0]['ccl'],
                "max_ccl_time": max_ccls[0]['time'],            
                "max_sum_ccl": max_sum_ccls[0]['sum_ccl'],
                "max_sum_ccl_time": max_sum_ccls[0]['time'],
                
            }
            results.append(result)
            utils.log("Finish {} - {}".format(start_time, end_time))
        
        utils.convert_dic_to_csv("ccl_min_max", results)        
    except Exception as e:
        utils.log(e)
        utils.log("Results: {}".format(results))
        
    return

def ccl_abnormal():
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
    # update_sum_ccl("rb")
    # output_csv("rb")
    # cjl_avg_dev("rb", "2020-01-01")
    daily_min_max_ccl("rb", "2021-12-01", "2021-04-03")

