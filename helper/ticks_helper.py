import math
from . import constance, utils, date_utils
from statistics import mean, variance, stdev

def get_ticks(start_date, end_date, contract_type = "", col_type = "5sec"):
    col_name = ""
    
    yesterday = date_utils.datestr_add_days(start_date, -1)
    if col_type == "real":
        col_name = "realTimeTick"         
    elif col_type == "1sec":
        col_name = "tick_{}_main".format(contract_type)
    elif col_type == "5sec":
        col_name = "tick_{}_main_5_sec".format(contract_type)
    elif col_type == "1min":
        col_name = "tick_{}_main_1_min".format(contract_type)
    
    yesterday = date_utils.datestr_add_days(start_date, -1, "-")
    start_time = "{} 21:00:00.000".format(yesterday)
    end_time = "{} 15:00:00.000".format(end_date)
    
    cols = constance.FUTURE_DB[col_name]
    filter = {"time": {"$gte": start_time, "$lte": end_time}}
    utils.log("filter: {}".format(filter))
    ticks = list(cols.find(filter).sort("time", 1))
    return ticks


def get_ticks_by_time(time, contract_type="", col_type="5sec"):
    col_name = ""
    if col_type == "real":
        col_name = "realTimeTick"
    elif col_type == "1sec":
        col_name = "tick_{}_main".format(contract_type)
    elif col_type == "5sec":
        col_name = "tick_{}_main_5_sec".format(contract_type)
    elif col_type == "1min":
        col_name = "tick_{}_main_1_min".format(contract_type)

    cols = constance.FUTURE_DB[col_name]
    filter = {"time": {"$lte": time}}
    utils.log("filter: {}".format(filter))
    num = get_x_span_number(5, col_type, "d")
    ticks = list(cols.find(filter).sort("time", 1).limit(num))
    return ticks

def get_ticks_dates(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    return main_col.distinct("date")

# 1 workday = 5.75 hour
def get_x_span_number(x, span_type = "1sec", unit="h"):    
    if unit == "m":        
        unit_in_sec = 60
    elif unit == "h":
        unit_in_sec = 3600
    elif unit == "d":
        unit_in_sec = 3600 * 5.75
    elif unit == "s":
        unit_in_sec = 1
    # get the span
    if span_type in ("1sec", "main"):
        sec_diff = 1
    elif span_type in ("5sec", "real"):
        sec_diff = 5
    elif span_type == "1min":
        sec_diff = 60

    return int(x * unit_in_sec / sec_diff)
    
            
    
        
