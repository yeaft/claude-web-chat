import click
from helper import constance, utils, date_utils
from statistics import mean, variance, stdev

def tick_5_sec(contract_type, start_time = "0000-00-00 00:00:00.000", end_time = "9999-99-99 99:99:99.999"):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    five_sec_main_col = constance.FUTURE_DB['tick_{}_main_5_sec'.format(contract_type)]
    cjl = 0
    ticks = []
    allowed_sec = ["00.000", "05.000", "10.000", "15.000", "20.000", "25.000", "30.000", "35.000", "40.000", "45.000", "50.000", "55.000"]
    for tick in main_col.find({"time": {"$gte": start_time, "$lt": end_time}}).sort("time", 1):
        # If change code, then ignore existed data
        second = tick["time"].split(":")[-1]
        if second in allowed_sec:
            tick['cjl'] += cjl
            ticks.append(tick)
            cjl = 0
        else:
            cjl += tick['cjl']
        
        if len(ticks) >= 100000:
            # five_sec_main_col.delete_many({"time": {"$gte": ticks[0]['time'], "$lte": ticks[-1]['time']}})
            five_sec_main_col.insert_many(ticks)
            utils.log("Finish batch data {} from {} to {}".format(len(ticks), ticks[0]['time'], ticks[-1]['time']))
            ticks = []
    
    if len(ticks) > 0:
        # five_sec_main_col.delete_many(
        #     {"time": {"$gte": ticks[0]['time'], "$lte": ticks[-1]['time']}})
        five_sec_main_col.insert_many(ticks)
    
    utils.log("Finish all data")


if __name__ == "__main__":
    tick_5_sec("rb")
