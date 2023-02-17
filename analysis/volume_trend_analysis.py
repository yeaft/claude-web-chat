from helper import constance, utils, date_utils, analysis_helper
from statistics import mean, variance, stdev
import numpy as np

# check correlation
def zxj_ccl_correlation(ticks):
    zxjs, ccls = [], []
    code = ""
    for x in ticks:
        code = x['code']
        zxjs.append(x['zxj'])
        ccls.append(x['sum_ccl'])

    if len(zxjs) < 10 or len(ccls) < 10:
        return None
    
    correlation = np.corrcoef(zxjs, ccls)
    utils.log("{}-{} correlation: {}".format(ticks[0]['time'], ticks[-1]['time'], correlation[0][1]))
    return {
        "startTime": ticks[0]['time'],
        "endTime": ticks[-1]['time'],
        "code": code,
        "correlation": correlation[0][1]
    }
    
def get_ticks(start_date, end_date, contract_type = "", col_type = "5sec"):
    col_name = ""
    
    yesterday = date_utils.datestr_add_days(start_date, -1)
    if col_type == "real":
        col_name = "realTimeTick"
        start_date.replace("-", "")
        end_date.replace("-", "")
        yesterday = date_utils.datestr_add_days(start_date, -1)
        start_time = "{} 210000".format(yesterday)
        end_time = "{} 150000".format(end_date)
    else:
        yesterday = date_utils.datestr_add_days(start_date, -1, "-")
        start_time = "{} 21:00:00.000".format(yesterday)
        end_time = "{} 15:00:00.000".format(end_date)
        if col_type == "main":
            col_name = "tick_{}_main".format(contract_type)
        elif col_type == "5sec":
            col_name = "tick_{}_main_5_sec".format(contract_type)
        elif col_type == "1min":
            col_name = "tick_{}_main_1_min".format(contract_type)
    
    cols = constance.FUTURE_DB[col_name]   
    ticks = list(cols.find({"type": contract_type,"time": {"$gte": start_time, "$lte": end_time}}).sort("time", 1))
    utils.log("get ticks {}".format(ticks))
    return ticks
    
    
        

def zxj_ccl_correlation_statistic(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    MAIN_DATES = main_col.distinct("date")
    results = []
    for date in MAIN_DATES:
        corre = zxj_ccl_correlation(contract_type, date, date)
        if corre != None:
            results.append(corre)
        
    utils.convert_dic_to_csv("correlation_{}".format(contract_type), results)

if __name__ == "__main__":
    # update_sum_ccl("rb", "2020-01-01 21:00:00.000")
    # output_csv("rb")
    # cjl_avg_dev("rb", "2020-01-01")
    # daily_ccl_analysis("rb", "2020-01-20", "2022-12-31")
    # ccl_cjl_price_avg_dev("rb")
    # get_daily_statistic_info("rb")
    # verify_ccl_trend_point("rb", "2022-08-23 10:41:00.000", True)
    # check_trend_accuracy("rb", "2022-01-10", "2022-12-31")
    # check_open_ccl_accurate("i", "2022-11-01", "2022-11-31")
    # ccl_day_filter("rb", "2022-12-01")
    # missing: "2022-12-08 22:40:00" "12-13 21:11" "12-26 21:40" "12-15 11:02"
    # zxj_ccl_correlation("rb", "2022-08-01", "2022-08-01")
    # zxj_ccl_correlation_statistic("rb")
    # zxj_ccl_correlation_statistic("i")
    utils.log("")