#!/usr/bin/python3
from ctypes import util
import time
import re

from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils

def save_data_2_db(paths, col_name):
    headers = ["market","code","time","zxj","ccl","zjl","cje","cjl"]
    number_headers = ["zxj", "ccl", "zjl", "cje", "cjl"]
    datas = []    
    start_time, count, batch_size  = time.time(), 1, 100000
    utils.log("File number {}".format(len(paths)))
    for p in paths:
        with open(p, "r") as f:
            for line in f.readlines()[1:]:
                data_str = line.replace("\r", "").replace("\n", "")
                data_arr = data_str.split(",")
                data = {}
                for i in range(len(headers)):
                    data[headers[i]] = float(data_arr[i]) if headers[i] in number_headers else (
                        data_arr[i] if i != 1 else data_arr[i].lower())
                data['date'] = data['time'][:10]
                datas.append(data)

                if len(datas) >= batch_size:
                    utils.log("Start insert to db, number {}".format(
                        count * batch_size))
                    count += 1
                    constance.FUTURE_DB[col_name].delete_many(
                        {"time": {"$gte": datas[0]['time'], "$lte": datas[-1]['time']}})
                    constance.FUTURE_DB[col_name].insert_many(datas)
                    datas = []   
    
    if len(datas) > 0:
        utils.log("Start insert to db, number {}".format(
            count * batch_size + len(datas)))
        constance.FUTURE_DB[col_name].delete_many({"time": {"$gte": datas[0]['time'], "$lte": datas[-1]['time']}})
        constance.FUTURE_DB[col_name].insert_many(datas)
    
    using_time = round(time.time() - start_time, 2)
    utils.log("Finish insert to database {}, using {}ms".format(col_name, using_time))    

def save_data_2_disk(paths, contract_type):
    headers = ["market","code","time","zxj","ccl","zjl","cje","cjl"]
    number_headers = ["zxj", "ccl", "zjl", "cje", "cjl"]
    datas = []    
    for p in paths:
        with open(p, "r") as f:
            for line in f.readlines()[1:]:
                data_str = line.replace("\r", "").replace("\n", "")
                data_arr = data_str.split(",")
                data = {}
                for i in range(len(headers)):
                    data[headers[i]] = float(data_arr[i]) if headers[i] in number_headers else (
                        data_arr[i] if i != 1 else data_arr[i].lower())              
                datas.append(data)    
    utils.log("Finish collect '{}' data, Start insert to database now.".format(contract_type))
    start_time = time.time()
    

    if contract_type == "main":
        constance.TICK_COL.insert_many(datas)
    else:
        constance.TICK_SECOND_COL.insert_many(datas)
    using_time = round(time.time() - start_time, 2)
    utils.log("Finish insert to database now. using {}ms".format(using_time))

# def get_arbitrage_diff(contract_type):
#     main_col = 

def get_paths(path, pattern):
    final_paths = []
    paths = file_utils.get_files_from_directory(path)
    prog = re.compile(pattern)
    for p in paths:
        if prog.match(p):
            final_paths.append(p)
    return final_paths

def get_contract_file_pattern(contract_type):
    return ".*{0}\d+_\d+.csv".format(contract_type)

def extra_filter_files(paths, start_date):
    new_paths = []
    for path in paths:
        date = path.split("_")[1].split(".")[0]
        if date >= start_date:
            new_paths.append(path)
    
    return new_paths

def extract_second_from_main(contract_type, start_date = "2020-01-02"):
    main_col = constance.FUTURE_DB["tick_{}_main".format(contract_type)]
    sec_col = constance.FUTURE_DB["tick_{}_sec".format(contract_type)]
    type_col = constance.FUTURE_DB["tick_{}".format(contract_type)]
    main_dates = main_col.distinct("date")
    start_index = main_dates.index(start_date) if start_date in main_dates else 0
    for i in range(start_index, len(main_dates)):        
        start_date = main_dates[i]
        main_tick = main_col.find_one({"date": start_date})
        main_code = main_tick['code']
        second_code = list(type_col.find({"code": {"$ne": main_code}, "time": {"$gte": "{} 14:59:00.000".format(
            start_date), "$lte": "{} 15:00:00.500".format(start_date)}}).sort("ccl", -1).limit(1))[0]['code']
        
        utils.log("Date {}, main code {}, second code {}".format(start_date, main_code, second_code))
        
        start_time = "{} 21:00:00.000".format(main_dates[i-1]) if i > 0 else "{} 09:00:00.000".format(start_date)
        sec_ticks = list(type_col.find({"code": second_code, "time": {
                         "$gte": start_time, "$lte": "{} 15:00:00.000".format(start_date)}}, {"_id":0}))
        
        # sec_col.delete_many({"time": {"$gte": sec_ticks[0]['time'], "$lte": sec_ticks[-1]['time']}})
        sec_col.insert_many(sec_ticks)
        utils.log("Finish insert {} sec data on {}".format(len(sec_ticks), start_date))
    return


def collect_data(contract_type = "rb", path="E:/Data/sc"):    
    # patterns = [".*rb主力连续_\d+.csv", ".*rb次主力连续_\d+.csv"]
    # col_formats = ["tick_{}_main", "tick_{}_sec"]
    patterns = [".*rb\d+_\d+.csv"]
    col_formats = ["tick_{}"]
    # pattern = get_contract_file_pattern("SA")
    for i in range(0, len(patterns)):        
        col_format = col_formats[i]
        col_name = col_format.format(contract_type.lower())
        pattern = patterns[i]
        paths = get_paths(path, pattern)
        # paths = extra_filter_files(paths, "20211201")
        # utils.log("new paths: {}".format(paths))
        save_data_2_db(paths, col_name)

if __name__ == "__main__":
    # collect_data()
    extract_second_from_main("rb")
