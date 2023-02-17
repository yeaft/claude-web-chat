import math
from . import constance, utils, date_utils
from statistics import mean, variance, stdev

def get_ticks(start_date, end_date, contract_type = "", col_type = "5sec"):
    col_name = ""
    
    yesterday = date_utils.datestr_add_days(start_date, -1)
    if col_type == "real":
        col_name = "realTimeTick"         
    elif col_type == "main":
        col_name = "tick_{}_main".format(contract_type)
    elif col_type == "5sec":
        col_name = "tick_{}_main_5_sec".format(contract_type)
    elif col_type == "1min":
        col_name = "tick_{}_main_1_min".format(contract_type)
    
    yesterday = date_utils.datestr_add_days(start_date, -1, "-")
    start_time = "{} 21:00:00.000".format(yesterday)
    end_time = "{} 15:00:00.000".format(end_date)
    
    cols = constance.FUTURE_DB[col_name]   
    ticks = list(cols.find({"type": contract_type,"time": {"$gte": start_time, "$lte": end_time}}).sort("time", 1))
    utils.log("get ticks {}".format(ticks))
    return ticks

def get_ticks_dates(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    return main_col.distinct("date")

# 1 workday = 5.75 hour
def get_x_ago_tick_index(ticks, current_index, x, unit="h"):    
    if unit == "m":        
        unit_in_sec = 60
    elif unit == "h":
        unit_in_sec = 3600
    elif unit == "d":
        unit_in_sec = 3600 * 5.75
    # get the span
    sec_diff = date_utils.sec_diff(ticks[current_index]["time"], ticks[current_index - 1]["time"])
    steps = int(unit_in_sec / sec_diff) * x
    return current_index - steps
    
            
    
        