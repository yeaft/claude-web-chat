import click
from helper import constance, utils, date_utils

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
            start_time = "{} 09:00:00.000".format(current_date)
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
        
        utils.convert_dics_str("ccl_min_max", results)        
    except Exception as e:
        utils.log("Results: {}".format(results))
        
    return

def ccl_abnormal():
    return

# Once pass this check send a alert, to prepare the trade
# 0. if far away from price detected, then change back
# 1. continous two units >= mean + 2 * stdev
# 2. Or one unit mean + 4 * stdev
# 3. Or past 6 unit sum > past 3 mins sum
def cjl_abnormal(contract_type, start_date, end_date):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    # max_ main_col.find({'time':{"$lte": end_date, "$gte": start_date}}).sort("time", 1):
    return 

# Refer to past 5 days, day or night cjl avg and stdev.
def cjl_avg_dev(contract_type, start_time, end_time):

        
        

if __name__ == "__main__":
    # update_sum_ccl("rb")
    # output_csv("rb")
    daily_min_max_ccl("rb", "2021-03-03", "2021-04-03")
