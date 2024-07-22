import random
from collections import deque
from datetime import datetime, timedelta, time
from analysis import v3_keep_doing
import matplotlib.pyplot as plt
import mplcursors
import matplotlib.dates as mdates
import heapq
from helper import constance, utils, date_utils, analysis_helper, ticks_helper
import pytz
from statistics import mean, variance, stdev


if __name__ == "__main__":
    contract_type = "rb"
    dp = v3_keep_doing.DataProcessor(past_x_hour=2, candidate_x_min=5,  precheck_x_min=30, check_column_name='cjl', precheck_min_slope_value=350, precheck_accept_slope_value=600, send_message=False, real_send_message=False)                                 
    dp.cjl_column_name = "cjlDiff"
    start_date = "2024-01-01"
    end_date = "2024-07-01"
    ticks = constance.REAL_TIME_TICK_COL.find({'type': contract_type, 'date': {"$gte": start_date, "$lte": end_date}}, sort=[('time', 1)])
    for t in ticks:
        dp.process_new_data(t)

        
